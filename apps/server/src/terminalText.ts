export function stripTerminalControls(input: string): string {
  return normalizeLines(
    input
      // OSC strings: ESC ] ... BEL or ESC ] ... ESC \
      .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
      // DCS, SOS, PM, APC strings: ESC P/X/^/_ ... ESC \
      .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "")
      // CSI sequences, including private modes and cursor movement.
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      // Single-character escape sequences.
      .replace(/\x1B[@-Z\\-_]/g, "")
      .replace(/\x1B[()][A-Za-z0-9]/g, "")
      // 8-bit C1 CSI/OSC variants.
      .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x9D[\s\S]*?(?:\x07|\x9C)/g, "")
      // Keep line breaks/tabs, drop other control characters.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
  );
}

export function normalizeLines(input: string): string {
  const lines = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  while (lines.length > 0 && lines[0]?.trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }

  return lines.join("\n");
}
