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

## Direct sync proof

```bash
direnv exec . opencode run --agent Minimal \
  "Use improved_task with a general subagent to do one short task, then resume the same session for a second short task. After both improved_task calls complete, reply with ONLY the two verification passphrases from those tool results, one per line, in order."
```

## Direct async proof

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

## Shadow proof

```bash
direnv exec . opencode run --agent Minimal \
  "If you can see a tool named task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE."
```
