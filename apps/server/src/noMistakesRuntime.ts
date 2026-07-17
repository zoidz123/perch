import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_VENDOR_ROOT = fileURLToPath(new URL("../../../vendor/no-mistakes", import.meta.url));
const EXEC_TIMEOUT_MS = 4_000;

type RuntimePlatform = {
  path: string;
  architecture: string;
  binaryBytes: number;
  binarySha256: string;
  releaseAsset: string;
  releaseAssetSha256: string;
  cdHashSha256: string;
};

export type NoMistakesRuntimeManifest = {
  schemaVersion: number;
  source: "bundled";
  releaseRepository: string;
  releaseUrl: string;
  releaseTag: string;
  releaseImmutable: boolean;
  releaseAttestation: "github";
  version: string;
  authorizationProtocol: string;
  forkCommit: string;
  upstreamRepository: string;
  upstreamBaseCommit: string;
  build: { goVersion: string; buildDate: string };
  signing: {
    authority: string;
    teamId: string;
    identifier: string;
    hardenedRuntime: boolean;
    secureTimestamp: string;
    notarized: boolean;
  };
  platforms: Record<string, RuntimePlatform>;
};

export type NoMistakesRuntimeFacts = {
  version: string;
  path: string;
  sha256: string;
  source: "bundled";
  architecture: string;
  protocol: string;
  releaseTag: string;
  forkCommit: string;
};

export type NoMistakesRuntimeResolution = {
  ok: boolean;
  facts?: NoMistakesRuntimeFacts;
  manifest: NoMistakesRuntimeManifest;
  error?: string;
};

export function readNoMistakesRuntimeManifest(
  vendorRoot = DEFAULT_VENDOR_ROOT
): NoMistakesRuntimeManifest {
  return JSON.parse(readFileSync(join(vendorRoot, "manifest.json"), "utf8")) as NoMistakesRuntimeManifest;
}

export function resolveBundledNoMistakes(options: {
  vendorRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): NoMistakesRuntimeResolution {
  const vendorRoot = options.vendorRoot ?? DEFAULT_VENDOR_ROOT;
  const manifest = readNoMistakesRuntimeManifest(vendorRoot);
  const platform = options.platform ?? hostPlatform();
  const arch = options.arch ?? hostArch();
  if (platform !== "darwin") {
    return { ok: false, manifest, error: `unsupported no-mistakes platform: ${platform}` };
  }
  const key = arch === "arm64" ? "darwin-arm64" : arch === "x64" ? "darwin-x64" : undefined;
  if (!key) {
    return { ok: false, manifest, error: `unsupported no-mistakes architecture: ${arch}` };
  }
  const selected = manifest.platforms[key];
  if (!selected) {
    return { ok: false, manifest, error: `no bundled no-mistakes runtime for ${key}` };
  }
  const binaryPath = join(vendorRoot, selected.path);
  try {
    accessSync(binaryPath, constants.X_OK);
    const stat = statSync(binaryPath);
    if (!stat.isFile()) throw new Error("runtime is not a regular file");
    if (stat.size !== selected.binaryBytes) throw new Error("runtime byte length mismatch");
    const binary = readFileSync(binaryPath);
    const sha256 = createHash("sha256").update(binary).digest("hex");
    if (sha256 !== selected.binarySha256) throw new Error("runtime SHA-256 mismatch");
    const cpuType = binary.length >= 8 ? binary.readUInt32LE(4) : 0;
    const expectedCpuType = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (cpuType !== expectedCpuType) throw new Error("runtime architecture mismatch");
    return {
      ok: true,
      manifest,
      facts: {
        version: manifest.version,
        path: binaryPath,
        sha256,
        source: "bundled",
        architecture: selected.architecture,
        protocol: manifest.authorizationProtocol,
        releaseTag: manifest.releaseTag,
        forkCommit: manifest.forkCommit
      }
    };
  } catch (error) {
    return {
      ok: false,
      manifest,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function validateBundledNoMistakes(options: {
  vendorRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<NoMistakesRuntimeResolution> {
  const resolution = resolveBundledNoMistakes(options);
  if (!resolution.ok || !resolution.facts) return resolution;
  try {
    const { stdout } = await execFileAsync(resolution.facts.path, ["--version"], {
      timeout: EXEC_TIMEOUT_MS,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: options.env?.HOME,
        NO_MISTAKES_TELEMETRY: "0"
      }
    });
    const expectedVersion = `v${resolution.manifest.version}`;
    const expectedProtocol = `authorization-protocol=${resolution.manifest.authorizationProtocol}`;
    if (!stdout.includes(expectedVersion)) throw new Error("runtime version mismatch");
    if (!stdout.includes(expectedProtocol)) throw new Error("runtime authorization protocol mismatch");
    return resolution;
  } catch (error) {
    return {
      ok: false,
      manifest: resolution.manifest,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function noMistakesVendorRoot(): string {
  return dirname(join(DEFAULT_VENDOR_ROOT, "manifest.json"));
}
