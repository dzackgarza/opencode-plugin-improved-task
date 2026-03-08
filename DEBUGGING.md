# Plugin Load Problem

## Goal

Shadow the built-in `task` tool with an improved implementation that adds `session_id`,
`mode`, and `timeout_ms` parameters and replaces `command` / `task_id`.

## Observed Symptom

When OpenCode runs, the `task` tool always has the built-in schema:

- `command` (optional)
- `description`
- `prompt`
- `subagent_type`
- `task_id` (optional)

Our improved schema (`session_id`, `mode`, `timeout_ms`) never appears.

## Environment

- OpenCode binary: `/home/dzack/.opencode/bin/opencode`
- Global config: `~/.config/opencode/opencode.json` (symlinked from `~/ai/opencode/opencode.json`)
- Plugin source: `/home/dzack/opencode-plugins/improved-task/src/index.ts`
- Plugin registered as: `file:///home/dzack/opencode-plugins/improved-task/src/index.ts`
- Each `opencode run` is a fresh process — no stale server.

## What Has Been Tried and What It Showed

### 1. Original structure: `index.ts` re-exports `task.ts`

`src/index.ts` contained only:

```ts
export { TaskPlugin } from "./task.ts";
```

All plugin logic lived in `src/task.ts`.

**Result:** Built-in schema always shown. Plugin appeared to not load.

### 2. Renamed export / renamed tool

Renamed plugin export to `ZZZTestLoadPlugin`, renamed tool to `zzztest_task_loaded`.

**Result:** `zzztest_task_loaded` never appeared in the model's tool list. Plugin not loading.

### 3. Inlined task.ts into index.ts, deleted task.ts

Moved all content from `task.ts` directly into `index.ts`. Renamed export to
`ImprovedTaskPlugin`. This matches the structural pattern of `improved-webtools/src/index.ts`
which loads correctly.

**Result:** No live test run yet. Unknown whether this fixed the load issue.

### 4. Removed `export` from all helper functions

`index.ts` was exporting ~16 helper functions in addition to the plugin. Removed `export`
from all of them, leaving only `export const ImprovedTaskPlugin`.

**Result:** No live test run yet.

### 5. Smoke plugin confirms file:// loading works

Created `src/smoke.ts` — a minimal plugin with no imports. Registered it in global config.

**Result:** Smoke plugin appears in load log and logs `SmokePlugin initialized`. Confirms
the `file://` mechanism works and OpenCode is reading the config correctly.

### 6. smoke.ts updated to import @opencode-ai/plugin and define a task tool shadow

Added `import { tool } from "@opencode-ai/plugin"` to smoke.ts and defined a `task` tool
with description `"SMOKE_SHADOW_CONFIRMED"`.

**Result:** NOT YET TESTED. This was written but never run.

## What Is Ruled Out

- **Config not being read.** The smoke plugin loads from the same config file.
- **`file://` path mechanism broken.** Smoke and webtools both use it and load.
- **Shadowing impossible in principle.** Not yet confirmed either way — Step 1 of smoke
  test was never actually executed.
- **Export name mattering.** Renaming to `ZZZTestLoadPlugin` made no difference.
- **Tool name mattering.** Renaming to `zzztest_task_loaded` made no difference.

## What Is NOT Ruled Out

- Whether `index.ts` in its current state actually loads (never tested live since inlining).
- Whether shadowing the built-in `task` tool is possible at all.
- Whether `index.ts` throws silently on import in OpenCode's bun context.
- Whether the Node.js built-in imports (`node:child_process` etc.) cause a silent failure.

## Environment Notes

- `opencode` shell alias does NOT invoke the real binary — it shows the `attach` help only.
- Always use the binary directly: `/home/dzack/.opencode/bin/opencode`
- One-shot runs: `/home/dzack/.opencode/bin/opencode run --agent Minimal "prompt"`

## Diagnostic Results (Stages 1–8)

All stages passed. Summary:

| Stage | Delta | Result |
|-------|-------|--------|
| 1 | Minimal stub, no node: imports | ✅ task_diag_1 visible |
| 2 | `import { promisify } from "node:util"` | ✅ |
| 3 | `import { join } from "node:path"` | ✅ |
| 4 | `import { tmpdir } from "node:os"` | ✅ |
| 5 | `import { promises as fs } from "node:fs"` | ✅ |
| 6 | `import { execFile } from "node:child_process"` + `execFileAsync` | ✅ |
| 7 | Rename tool to `task` | ✅ Shadow confirmed: returns `STAGE7_SHADOW_CONFIRMED` |
| 8 | Full implementation in smoke.ts, tool name `task` | ✅ Parameters include `session_id`, `mode`, `timeout_ms` |

## Root Cause

The node: imports were **not** the problem. All imports work fine in OpenCode's bun context.

The original `index.ts` was never tested live after inlining. The `file://` registration for
`index.ts` itself may have been failing for a different reason (export name, hooks-based approach
rather than direct tool shadow, or some other silent issue).

**Direct tool shadowing works:** Defining `tool: { task: ... }` in the plugin return value
successfully replaces the built-in `task` tool.

## Resolution

Full implementation is now in `smoke.ts` (exported as `ImprovedTaskPlugin`), which is registered
in the global config. The `task` tool is directly shadowed with the improved schema.

`index.ts` is a dead stub — either remove it from config or delete it.
