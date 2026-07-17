import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesPersistedProcess } from "./orphanProcess.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function lstartOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, " ");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${day} ${time} ${date.getFullYear()}`;
}

test("orphan process proof requires matching provider command and birth marker", () => {
  const identity = {
    processId: 42,
    processStartedAt: "2026-07-14T19:41:30.993Z",
    provider: "claude"
  };
  const born = lstartOf(new Date(identity.processStartedAt));
  const bornEarlier = lstartOf(new Date(Date.parse(identity.processStartedAt) - 60_000));
  assert.equal(
    matchesPersistedProcess(identity, `${born} /opt/homebrew/bin/claude --resume abc`),
    true
  );
  assert.equal(
    matchesPersistedProcess(identity, `${born} /opt/homebrew/bin/codex resume abc`),
    false
  );
  assert.equal(
    matchesPersistedProcess(identity, `${bornEarlier} /opt/homebrew/bin/claude --resume abc`),
    false
  );
});
