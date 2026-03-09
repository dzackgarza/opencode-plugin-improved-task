[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)


# improved-task

This OpenCode plugin adds the `improved_task` tool and shadows the built-in `task` tool with a plugin-backed implementation.

## Install

Install the plugin from its directory:

```bash
cd /home/dzack/opencode-plugins/improved-task
just install
```

Register the plugin in OpenCode via `file:`:

```json
{
  "plugin": ["file:///home/dzack/opencode-plugins/improved-task/"]
}
```

See the sample local configuration: [`improved-task/.config/opencode.json`](/home/dzack/opencode-plugins/improved-task/.config/opencode.json).

**Note:** This package depends on the OpenCode child-session lifecycle and does not function as a standalone MCP server.

## Tool Names

### `improved_task`

This tool delegates work to a subagent using native task lifecycle semantics. Use it to handle scoped work through a specialized subagent.

At runtime, the plugin appends the available subagent list and a verification passphrase when in test mode.

#### Schema

- `description`: string
- `prompt`: string
- `subagent_type`: string
- `mode?`: "sync" | "async"
- `timeout_ms?`: number
- `session_id?`: string

### `task`

The `task` tool shares the same schema and runtime behavior as `improved_task`. This plugin intentionally shadows the built-in `task` name.

## Dependencies

- Runtime: Bun, OpenCode, `@opencode-ai/plugin`
- Optional local tooling: `direnv`
- External contract: configured OpenCode subagents

## Checks

```bash
just typecheck
just test
```
