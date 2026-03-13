[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# improved-task

This OpenCode plugin adds the `improved_task` tool and shadows the built-in `task` tool with a plugin-backed implementation.

## Install

Install the plugin from its directory:

```bash
cd improved-task
direnv allow .
just install
```

Repo-local verification uses [`.envrc`](./.envrc), [`.config/opencode.json`](./.config/opencode.json), and a checked-in symlink under [`.config/plugins`](./.config/plugins) so OpenCode loads the real exporter without a machine-specific `file://` path.

**Note:** This package depends on the OpenCode child-session lifecycle and does not function as a standalone MCP server.

## Tool Names

### `improved_task`

This tool delegates work to a subagent using native task lifecycle semantics. Use it to handle scoped work through a specialized subagent.

At runtime, the plugin appends the available subagent list to the tool description.
In test mode, the description carries a visibility passphrase and execution-result
paths carry distinct result passphrases.

#### Schema

- `description`: string
- `prompt`: string
- `subagent_type`: string
- `mode?`: "sync" | "async"
- `timeout_ms?`: number
- `session_id?`: string

### `task`

The `task` tool shares the same schema and runtime behavior as `improved_task`. This plugin intentionally shadows the built-in `task` name.

## Output Contract

Successful sync completion returns a markdown report with YAML front matter:

- `session_id`
- `tokens_used`
- `num_tool_calls`
- `transcript_path`
- `time_elapsed`

The report body is organized into these sections:

- `## Agent's Last Message`
- `## Turn-by-Turn Summary`
- `## Completion Review`

The turn summary is built from the `opencode-manager` transcript renderer plus the
structured transcript JSON surface (`opx-session transcript --json`) plus the
centralized prompt slug `micro-agents/transcript-summary` resolved through
`ai-prompts`. It includes transcript-derived narrative bullets first, then a
deterministic `### Observed Counts` block. `transcript_path` points to that
structured JSON artifact.

The report is also published into the parent session chat so both the user and later
agent turns can refer to the displayed result directly. A synthetic reminder is added
after the report to discourage redundant restatement.

Async calls return an initial running notice immediately and publish the same success
report into the parent session chat when the child session completes.

Actual TUI rendering remains a manual acceptance boundary. The plugin owns the
shadowing and session/report contract; OpenCode owns how that contract is rendered
in the interface.

Tool-description inspection proves visibility only. Execution and resume proofs in this
repo rely on raw tool outputs, published reports, manager-rendered transcripts, and
result-path verification passphrases that are unavailable before execution.

## Dependencies

- Runtime: Bun, OpenCode, `@opencode-ai/plugin`
- Optional local tooling: `direnv`
- External runtime CLIs: `opx-session transcript`, `ai-prompts get`, `llm-run`
- External contract: configured OpenCode subagents

## Checks

```bash
direnv allow .
just check
```

For targeted runs, keep using the canonical `justfile` entrypoints instead of direct
`bun test` / `bunx tsc` commands:

```bash
just typecheck
just test
just test-file tests/integration/task-plugin.test.ts 'config-defined subagents appear'
```
