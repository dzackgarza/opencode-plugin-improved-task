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

## Direct visibility proof

```bash
direnv exec . opencode run --agent Minimal \
  "If you can see a tool named improved_task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE."
```

## Report contract proof

```bash
MANAGER="npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git"

direnv exec . /home/dzack/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx run --agent Minimal --prompt \
  "Use improved_task exactly once with mode=sync and subagent_type general. In the child session, reply with ONLY QX4N7A1P. After the tool finishes, answer with ONLY OK." \
  --keep

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx session messages --session <parent-session-id>
```

Inspect the parent-session messages for the `tool` part output, the published report
message, and the synthetic reminder, not the rendered TUI.

## Async report proof

Async verification should use a repo-local server plus `opencode-manager`, not rendered
CLI/TUI output.

```bash
MANAGER="npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git"
TRANSCRIPT="uvx --from git+ssh://git@github.com/dzackgarza/opencode-transcripts.git opencode-transcript"

direnv exec . /home/dzack/.opencode/bin/opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  $MANAGER opx run --agent Minimal --prompt \
  "Use improved_task exactly twice, both times in async mode with subagent_type general. First create a new child session and wait for its completion message. Then call improved_task again with the returned session_id to resume that same child session, wait for the second completion message, and finally reply with ONLY the two verification passphrases from those two completion messages, one per line, in order. Do not inspect or use any tool other than improved_task." \
  --keep

# Poll the kept parent session for callback-delivered passphrases.
OPENCODE_BASE_URL=http://127.0.0.1:4198 $MANAGER opx session messages --session <session-id>
OPENCODE_BASE_URL=http://127.0.0.1:4198 $MANAGER opx debug trace --session <session-id> --verbose
OPENCODE_BASE_URL=http://127.0.0.1:4198 $TRANSCRIPT <session-id>
```

The async completion path publishes the final report into chat and then adds a
synthetic reminder, following the same visibility pattern as the improved todo tree.

## Manual TUI acceptance

Actual TUI behavior should be checked manually in a real interactive OpenCode session.
Use manual acceptance only for:

- task-tile/session-tree rendering
- child-session attachment in the UI
- async completion surfacing in the TUI
- any other rendering-specific behavior

Those are important, but they are not automatable proofs in this repo.

## Shadow proof

```bash
direnv exec . opencode run --agent Minimal \
  "If you can see a tool named task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE."
```
