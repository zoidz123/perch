import type { AgentKind } from "@perch/shared";

// A blocking interactive prompt read off the rendered screen, rather than off a
// hook. Every prompt perch knows about today arrives as a hook event, but the
// CLI only hooks its own tool calls: a slash-command confirm ("Switch model?"),
// a login prompt, a trust-this-directory prompt, or whatever the next CLI
// release adds fires no hook at all. The phone is then structurally blind to it
// and the composer types straight into the open dialog. This is the general net
// for those, so an unknown prompt surfaces as a decision card instead of
// silently swallowing the next message.
export type DetectedPrompt = {
  // Stable across re-renders of the SAME dialog, including cursor movement, so
  // a moved selection never re-raises the card or re-pushes.
  id: string;
  summary: string;
  // The numbered options, one per line, as the CLI rendered them.
  options: string[];
  remoteResolutionUnavailable?: boolean;
  decisions?: Array<{
    id: string;
    label: string;
    destructive?: boolean;
    persistence?: "turn" | "session" | "always";
    // PTY input is intentionally server-only. Clients receive the decision
    // metadata, never an unverified key sequence.
    input: string[];
  }>;
  context?: {
    app?: string;
    tool?: string;
  };
};

// The selection cursor the TUI draws in front of the highlighted option. It is
// the load-bearing half of the signal. Numbered lines alone are everywhere -
// code listings, changelogs, `ls -1`, this very comment - and a false positive
// means perch types a keystroke into a live agent, which is strictly worse than
// a missed card. So: no cursor, no prompt.
const CURSORS = ["❯", "›"] as const;

// Only the bottom of the screen is inspected. Counted in NON-BLANK lines: the
// TUI anchors its boxes to the bottom of the viewport and pads the gap above
// with blank rows, so a dialog six content lines up can sit twenty-odd RAW
// lines from the bottom (measured in #91, which is why the model-switch barrier
// windows the same way). A raw window would look at padding and see nothing.
const WINDOW_LINES = 12;

// A dialog answerable with one keystroke. More than nine options is not a
// confirm frame, it is a list.
const MAX_OPTIONS = 9;

const OPTION_LINE = /^(\d)[.)]\s+(\S.*)$/;
const BORDER_CHARS = /^[\s│┃┆┇┊┋╎╏|]+|[\s│┃┆┇┊┋╎╏|]+$/g;
const HAS_WORD = /[A-Za-z0-9]/;

// Recognize an interactive prompt frame on `screen` (the rendered PTY text,
// terminal control sequences already stripped). Pure: no I/O, no clock.
//
// Claude only, deliberately. The frame (numbered options plus `❯`) and the key
// that answers it ("1", the same key `/sessions/:id/approve` already sends) are
// verified against Claude's TUI. Codex answers approvals with "y" and reports
// its prompts through hooks already, so guessing at its frames would buy a card
// perch cannot correctly answer. Adding an agent here means verifying both.
export function detectPrompt(screen: string, agent: AgentKind | undefined): DetectedPrompt | undefined {
  if (agent !== "claude" && agent !== "codex") {
    return undefined;
  }

  const lines = screen
    .split(/\r?\n/)
    .map((line) => line.replace(BORDER_CHARS, ""))
    .filter((line) => line.length > 0)
    .slice(-WINDOW_LINES);

  const options: string[] = [];
  let firstOptionAt = -1;
  let lastOptionAt = -1;
  let cursorSeen = false;

  for (const [index, line] of lines.entries()) {
    const cursorGlyph = CURSORS.find((candidate) => line.startsWith(candidate));
    const cursor = cursorGlyph !== undefined;
    const body = cursorGlyph ? line.slice(cursorGlyph.length).trimStart() : line;
    const match = OPTION_LINE.exec(body);
    if (!match) {
      continue;
    }
    // The options must be one contiguous block numbered 1..n. A gap means the
    // numbers came from prose or code that happens to sit near a `❯`.
    if (firstOptionAt >= 0 && index !== lastOptionAt + 1) {
      return undefined;
    }
    if (Number(match[1]) !== options.length + 1) {
      return undefined;
    }
    if (firstOptionAt < 0) {
      firstOptionAt = index;
    }
    lastOptionAt = index;
    cursorSeen ||= cursor;
    // Codex field prompts append explanatory copy in a second aligned column.
    // The choice label is the first column; descriptions remain context, not
    // part of the exact decision identity shown on mobile.
    const renderedOption = match[2]!.trim();
    options.push(agent === "codex" ? renderedOption.split(/\s{2,}/, 1)[0]!.trim() : renderedOption);
  }

  if (options.length < 2 || options.length > MAX_OPTIONS || !cursorSeen) {
    return undefined;
  }

  const summary = titleFor(lines.slice(0, firstOptionAt));
  const app = lines
    .slice(0, firstOptionAt)
    .map((line) => /^App:\s*(.+)$/.exec(line)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const codexComputerUse =
    agent === "codex" &&
    /^Allow Computer Use to use .+\?$/.test(summary) &&
    app !== undefined &&
    options.length === 4 &&
    options[0] === "Allow" &&
    options[1] === "Allow for this session" &&
    options[2] === "Always allow" &&
    options[3] === "Cancel";
  const legacyCodexComputerUse =
    agent === "codex" &&
    summary === "Computer Use wants permission" &&
    options.length === 4 &&
    options[0] === "Allow" &&
    options[1] === "Allow for this session" &&
    options[2] === "Always allow" &&
    options[3] === "Cancel";
  if (agent === "codex" && !codexComputerUse && !legacyCodexComputerUse) return undefined;

  return {
    // Hashed over the title and the option text only - never the cursor
    // position, which moves as the user arrows through the dialog.
    id: `screen:${hash(`${summary}\n${options.join("\n")}`)}`,
    summary,
    options,
    ...(codexComputerUse
      ? {
          decisions: [
            {
              id: "allow",
              label: "Allow",
              persistence: "turn" as const,
              input: [...Array<string>(4).fill("\x1b[A"), "\r"]
            },
            {
              id: "allow_session",
              label: "Allow for this session",
              persistence: "session" as const,
              input: [...Array<string>(4).fill("\x1b[A"), "\x1b[B", "\r"]
            },
            {
              id: "allow_always",
              label: "Always allow",
              persistence: "always" as const,
              input: [...Array<string>(4).fill("\x1b[A"), "\x1b[B", "\x1b[B", "\r"]
            },
            {
              id: "cancel",
              label: "Cancel",
              destructive: true,
              input: [...Array<string>(4).fill("\x1b[A"), "\x1b[B", "\x1b[B", "\x1b[B", "\r"]
            }
          ],
          context: { app: app.replace(/^"|"$/g, ""), tool: "Computer Use" }
        }
      : {}),
    ...(legacyCodexComputerUse ? { remoteResolutionUnavailable: true } : {})
  };
}

// The dialog's question. Rules and box edges carry no words and are skipped.
// A CLI confirm asks something ("Switch model?", "Do you want to proceed?"), and
// the ask is the last such line before the options - everything above it is
// context that already scrolled past on the desktop. With no question line, the
// topmost content line is the best available header.
function titleFor(above: string[]): string {
  const content = above.filter((line) => HAS_WORD.test(line)).map((line) => line.trim());
  const asked = content.filter((line) => line.endsWith("?") || line.endsWith(":"));
  const title = asked.at(-1) ?? content.at(0);
  return title ? title.slice(0, 120) : "The agent is waiting on a choice";
}

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) {
    value = ((value << 5) + value + text.charCodeAt(index)) >>> 0;
  }
  return value.toString(16);
}
