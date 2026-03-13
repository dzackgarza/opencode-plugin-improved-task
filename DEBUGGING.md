# improved-task debugging

Use the standalone OpenCode binary with the plugin-local `direnv` environment.
For real workflow tests, run a dedicated custom-port `opencode serve` inside the same
`direnv` environment and point `opencode-manager` at it.

## Setup

```bash
cd improved-task
direnv allow
```

This exports:

- `OPENCODE_CONFIG=$PWD/.config/opencode.json`
- `IMPROVED_TASK_TEST_PASSPHRASE=SWORDFISH-TASK`

## Visibility proof

```bash
direnv exec . opencode run --agent improved-task-proof \
  "If you can see a tool named improved_task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE."
```

This proves visibility only:

- `SWORDFISH-TASK:improved_task:visible`

## Shadow visibility proof

```bash
direnv exec . opencode run --agent task-proof \
  "If you can see a tool named task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE."
```

This proves visibility of the shadowed name only:

- `SWORDFISH-TASK:task:visible`

## Report contract proof

```bash
MANAGER="npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git"

direnv exec . /home/dzack/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx run --agent improved-task-proof --prompt \
  "Use improved_task exactly once with mode=sync and subagent_type general. In the child session, complete a short task and answer the question 'what is 2 + 2?' in one short sentence. After the tool finishes, answer with ONLY OK." \
  --keep

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx session messages --session <parent-session-id>
```

Inspect the parent-session messages for the `tool` part output, the published report
message, and the synthetic reminder, not the rendered TUI. For a successful first sync
call, the report must include:

- `Verification passphrase: ${IMPROVED_TASK_TEST_PASSPHRASE}:improved_task:sync:new`
- a non-empty `## Agent's Last Message`

## Async report proof

Async verification should use a repo-local server plus `opencode-manager`, not rendered
CLI/TUI output.

```bash
MANAGER="npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git"
TRANSCRIPT="npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git opx-session transcript"

direnv exec . /home/dzack/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx run --agent improved-task-proof --prompt \
  "Use improved_task exactly twice, both times in async mode with subagent_type general. First create a new child session and let it complete a short task. Then call improved_task again with the returned session_id to resume that same child session and let it complete a second short task. After the second completion, answer with ONLY OK. Do not inspect or use any tool other than improved_task." \
  --keep

# Poll the kept parent session for callback-delivered reports.
OPENCODE_BASE_URL=http://127.0.0.1:4198 $MANAGER opx session messages --session <session-id>
OPENCODE_BASE_URL=http://127.0.0.1:4198 $MANAGER opx debug trace --session <session-id> --verbose
OPENCODE_BASE_URL=http://127.0.0.1:4198 $TRANSCRIPT <session-id>
```

The async completion path publishes the final report into chat and then adds a
synthetic reminder, following the same visibility pattern as the improved todo tree.
The `## Turn-by-Turn Summary` section is built from the manager's structured
transcript JSON output (`opx-session transcript --json`) plus the centralized
`micro-agents/transcript-summary` prompt resolved through `ai-prompts`.
The first completion report must include:

- `Verification passphrase: ${IMPROVED_TASK_TEST_PASSPHRASE}:improved_task:async:new`
- a non-empty `## Agent's Last Message`

The resumed completion report must include:

- `Verification passphrase: ${IMPROVED_TASK_TEST_PASSPHRASE}:improved_task:async:resume`
- a non-empty `## Agent's Last Message`
- the same `session_id` as the first completion report

## Manual TUI acceptance

Actual TUI behavior should be checked manually in a real interactive OpenCode session.
Use manual acceptance only for:

- task-tile/session-tree rendering
- child-session attachment in the UI
- async completion surfacing in the TUI
- any other rendering-specific behavior

Those are important, but they are not execution proofs in this repo. Execution proofs
must come from result-path passphrases, raw tool outputs, published reports, or
transcripts that the agent could not satisfy without the real tool path succeeding.
