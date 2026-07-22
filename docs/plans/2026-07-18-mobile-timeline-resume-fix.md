# Mobile timeline resume fix: follow Claude's transcript fork after `--resume`

Date: 2026-07-18
Task: fix-claude-timeline-re-1b22
Reference: scout chart `da440af2d49ea8ea` (task `investigate-mobile-app-false-7c3c`)

## Symptom

After a Claude session resumes (recovery of a task worker or a mate), the mobile app:

1. Stops receiving all post-resume assistant responses.
2. Falsely shows "Not delivered" on messages the boss sends, ~45s after sending.

Both are one bug. The app can only render what `GET /timeline` returns, and after a resume that endpoint returns a frozen, pre-resume view.

## Root cause (verified)

Recovery launches `claude --resume <providerSessionId>` (`apps/server/src/providerRecovery.ts:41`).

`claude --resume <id>` does **not** keep writing to `<id>.jsonl`.
It **forks**: it replays the resumed-from transcript into a brand-new `<newId>.jsonl` in the same project directory and writes every new turn there.
The resumed-from file is abandoned (frozen).

Perch's Claude timeline tailer attaches exactly once, from the single `SessionStart` hook that names the resumed-from path (`apps/server/src/http.ts:4558-4577`, `apps/server/src/timeline.ts` `attach()`).
No further `SessionStart` hook ever names the fork, so the tailer keeps reading the frozen file forever.

Verified against on-disk transcripts of a live resumed mate (the scout's exact pair):

- Parent `c7815501-...jsonl`: frozen, last row `21:53:47Z` - matches the timeline's end exactly.
- Fork `aaa27ad4-...jsonl`: same project dir, same session, forked; kept accumulating to `02:29Z` - never tailed.
- The fork's first message-row uuid equals the parent's first message-row uuid (the fork replays from the conversation root; the anchor appears at fork line index 4).
- The fork rewrites the replayed rows' `sessionId` to its own id but **preserves their `uuid`s** (which is why parent and fork share message uuids).

Historical note: this plan predates app-server-owned Codex sessions.
Codex now receives timeline history and live events directly from the app-server protocol, so it does not use Claude's transcript-tail or fork-following path.

Note on timing: the fork appears at the **first post-resume turn**, not at launch. For a recovered task worker that is seconds later (the recovery kickoff). For an idle recovered mate it can be **hours** later (whenever the boss next messages it). A short bounded loop is therefore insufficient; the re-resolver must live for the session.

The iOS "Not delivered" is a downstream symptom: the client's only positive delivery signal is its own canonical user row echoing back through the timeline (`apps/ios/Perch/PerchClient.swift` `reconcileOptimistic`, ~393-407, 430-450). On a frozen timeline that row never arrives, so the 45s expiry fires even though the server accepted the input (202) and Claude answered it in the live fork.

## Fix

### Server (core): follow the fork

Add an active Claude transcript re-resolver scoped to resumed Claude sessions only (non-resumed sessions do not fork; scout-confirmed).

- `startManagedAgent` detects a Claude launch whose args include `--resume` and calls `timeline.followClaudeResume(sessionId, isAllowedTranscriptPath)`. This is the single chokepoint both mate recovery and task-worker recovery already pass through, while app-server-owned Codex recovery uses its separate thread-resume path.
- `TimelineStore.followClaudeResume` starts a long-lived resolver owned by the store (stopped in `detach`/`prune`/`stop`, sharing the tailer's lifecycle). On each tick it:
  1. Reads the currently-attached transcript path (`this.tailers.get(sessionId)?.path`); waits if the first attach has not happened yet.
  2. Establishes a lineage anchor once: the directory of the current transcript, and the transcript's first message-row `uuid`.
  3. Scans that directory for the newest `.jsonl` that is a lineage descendant - it contains the anchor uuid within a bounded prefix and has a strictly newer mtime than the current file - and calls `attach()` with it when it changes.
- Lineage is confirmed by the shared root uuid, never by mtime alone, so a concurrent unrelated session in the same project dir is never adopted (the scout's stated risk).

Why re-attach is seamless: `attach()` already stops the old tailer and re-verifies path containment (the TOCTOU re-check stays intact). The fork file contains the replayed prefix (same uuids) plus the new turns; `normalizeClaudeRow` ids rows by `uuid`, and the store dedups by id - so re-attaching to the full fork file re-emits nothing from before the resume and surfaces only the new post-resume rows.

`verifySessionStart` is intentionally left unchanged: the initial `SessionStart` on `--resume` reports the resumed-from id and `<id>.jsonl` (confirmed by the existing real-Claude E2E test), so the recovery identity check still holds. The fork is followed independently of identity verification, so relaxing the check is unnecessary and would only weaken it.

### iOS client (defense in depth): trust the 202

Make the client treat the server's `202` accept from `/submit` (input accepted + injected) as delivery-acknowledged, so a delayed or missing timeline echo can no longer produce a false "Not delivered". The canonical user row then only confirms the bubble; it no longer gates delivery. Minimal change consistent with the existing optimistic-send path.

## Verification

- Reproduce the server freeze before the fix and show it resolved after: a resumed Claude session's timeline must advance past the resume boundary and include post-resume assistant rows.
- Add/extend server tests for re-attach-on-resume (resume forks the transcript, the tailer re-points, new rows surface) without regressing codex tests or the containment re-check.
- Compile-check the Swift client change (full simulator app build deferred per boss trim).
- Run the relevant server test suite and the server build.

## Risks & open questions

- Claude's fork-on-resume trigger can vary by version (`--resume` vs `--fork-session`); the fix keys off "newest lineage descendant transcript for this session", not a specific flag or filename, so it is robust to that variance.
- The resolver scans a directory on an interval for the session's life. Cost is bounded: it only reads the bounded prefix of candidate files whose mtime exceeds the current tail, and once re-pointed to the live fork no older file qualifies.
