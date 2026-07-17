// Push notification boundary. APNs needs a paid Apple Developer account
// (.p8 auth key + entitlement), so v1 ships the interface with a no-op
// sender; wiring ApnsPushSender in later must not touch any call site.
//
// Policy note for the real implementation: presence ROUTES notifications
// (skip the device actively viewing the session) but must never GATE
// delivery - stale presence from a backgrounded app cannot suppress a push.

export type PushNotification = {
  title: string;
  // Where the agent works ("branch · path"), rendered under the title.
  subtitle?: string;
  body: string;
  sessionId: string;
  category: "approval" | "approval_choices" | "turn_done" | "error" | "mate_message" | "chart_ready";
  // iOS notification grouping. Defaults to the session (one thread per solo
  // session, approvals threaded per session); the mate conversation pins a
  // stable "mate" thread across mate restarts.
  threadId?: string;
};

export type PushSender = {
  send(notification: PushNotification): void | Promise<void>;
};

export class NoopPushSender implements PushSender {
  async send(notification: PushNotification): Promise<void> {
    // Logged so the policy layer is observable before APNs exists.
    console.log(`push (noop): [${notification.category}] ${notification.title} - ${notification.body}`);
  }
}

// --- APNs ---------------------------------------------------------------
// Token-based APNs over HTTP/2, zero dependencies: ES256 JWTs from the .p8
// auth key (node:crypto) and node:http2 sessions to Apple. Configured via
// env (PERCH_APNS_KEY/KEY_ID/TEAM_ID [+ _TOPIC/_ENV]); index.ts falls back
// to the noop sender when unconfigured.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

export type ApnsConfig = {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
  host: string;
};

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | undefined {
  // Env vars win; $PERCH_HOME/apns.json is the durable configuration (the
  // autostarted server never inherits ad-hoc shell env).
  const file = readApnsFile(env);
  const keyPath = env.PERCH_APNS_KEY ?? file?.key;
  const keyId = env.PERCH_APNS_KEY_ID ?? file?.keyId;
  const teamId = env.PERCH_APNS_TEAM_ID ?? file?.teamId;
  if (!keyPath || !keyId || !teamId) {
    return undefined;
  }
  const environment = env.PERCH_APNS_ENV ?? file?.environment;
  return {
    keyPath: keyPath.replace(/^~(?=\/)/, homedir()),
    keyId,
    teamId,
    topic: env.PERCH_APNS_TOPIC ?? file?.topic ?? "com.ellipsoid.perch",
    // Debug/dev builds talk to the sandbox gateway; TestFlight/App Store use prod.
    host:
      environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com"
  };
}

type ApnsFile = {
  key?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
  environment?: string;
};

function readApnsFile(env: NodeJS.ProcessEnv): ApnsFile | undefined {
  try {
    const home = env.PERCH_HOME ?? join(homedir(), ".perch");
    return JSON.parse(readFileSync(join(home, "apns.json"), "utf8")) as ApnsFile;
  } catch {
    return undefined;
  }
}

export class ApnsPushSender implements PushSender {
  private readonly key: KeyObject;
  private jwt?: { token: string; issuedAt: number };
  private session?: ClientHttp2Session;

  constructor(
    private readonly config: ApnsConfig,
    private readonly deviceTokens: () => string[]
  ) {
    this.key = createPrivateKey(readFileSync(config.keyPath, "utf8"));
  }

  async send(notification: PushNotification): Promise<void> {
    const tokens = this.deviceTokens();
    if (tokens.length === 0) {
      return;
    }
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: notification.title,
          ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
          body: notification.body
        },
        sound: "default",
        category: apnsCategory(notification.category),
        "thread-id": notification.threadId ?? notification.sessionId
      },
      sessionId: notification.sessionId
    });
    // Per-device delivery is independent: one stale token (APNs 410 is
    // routine) must not fail the whole send, or the durable outbox would
    // re-push to every healthy device on retry. Only an all-device failure
    // is a delivery failure worth retrying.
    const results = await Promise.allSettled(tokens.map((token) => this.post(token, payload)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    for (const failure of failures) {
      console.warn(
        `push: APNs device delivery failed: ${failure.reason instanceof Error ? failure.reason.message : failure.reason}`
      );
    }
    if (failures.length === tokens.length) {
      const reason = failures[0]!.reason;
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
  }

  private async post(deviceToken: string, payload: string): Promise<void> {
    const session = this.ensureSession();
    await new Promise<void>((resolve, reject) => {
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.bearer()}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json"
      });
      let status = 0;
      let body = "";
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(new Error(`APNs ${status}: ${body.slice(0, 200)}`));
        }
      });
      stream.on("error", reject);
      stream.end(payload);
    });
  }

  // Apple accepts a JWT for up to an hour; refresh at 50 minutes.
  private bearer(): string {
    const now = Date.now();
    if (this.jwt && now - this.jwt.issuedAt < 50 * 60_000) {
      return this.jwt.token;
    }
    const header = base64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const claims = base64url(
      JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) })
    );
    const signer = createSign("SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer
      .sign({ key: this.key, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    const token = `${header}.${claims}.${signature}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  private ensureSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    this.session = connect(this.config.host);
    this.session.on("error", () => {
      this.session = undefined;
    });
    return this.session;
  }
}

function apnsCategory(category: PushNotification["category"]): string {
  switch (category) {
    case "approval":
      return "PERCH_APPROVAL";
    case "approval_choices":
      return "PERCH_APPROVAL_CHOICES";
    case "mate_message":
      return "PERCH_MATE";
    default:
      return "PERCH_INFO";
  }
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
