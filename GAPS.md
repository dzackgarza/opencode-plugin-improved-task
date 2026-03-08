# GAPS — improved-task

## Known Gaps

### Integration tests must be rewritten from scratch

The current `tests/integration/task-plugin.test.ts` design is invalid and should not be
repaired incrementally. The replacement suite should use only live E2E passphrase proofs
that rely on the agent relaying hidden tokens returned by the tool.

Required replacement plan:

1. Expose the same implementation under a non-shadowed tool name such as `improved_task`
2. Emit distinct hidden passphrases for each path that must be proven:
   - tool visibility
   - sync new task
   - sync resume
   - async completion
   - async resume
3. Prove all behavior under the non-shadowed name first
4. Then prove shadowing separately with a visibility/schema-style passphrase test for `task`
5. Keep prompts natural: agent should use returned values like `session_id` itself instead of
   being walked through every intermediate step
6. Do not use logs, `opencode export`, transcript scraping, or other OpenCode internals as the
   proof artifact for passphrase tests

### Async lifecycle is not unit-testable

The async delivery path (background session runs, then fires a tool-after callback to
the parent session) requires a live OpenCode server with two concurrent sessions. This
is not exercisable via `bun test`.

### `computeCompletionConfidenceScore` heuristics not validated

The confidence score is built from heuristics (output length, message count).
These have no ground-truth validation — the score may misclassify failed tasks as
successful or vice versa.

### Subagent cache TTL edge cases

The `CachedSubagent` cache uses a 60-second TTL. If OpenCode registers/deregisters
subagents during a session, stale cache may route to a wrong or nonexistent subagent.
No test covers TTL expiry + re-fetch behavior.
