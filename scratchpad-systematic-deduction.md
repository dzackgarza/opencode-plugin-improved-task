# Systematic Deduction Scratchpad

## Problem Statement

The `task` tool in OpenCode always shows the built-in schema. Our improved plugin
(`index.ts`) is registered in the global config but its tool never appears.

---

## Known Facts (Proven)

- F1: `smoke.ts` (minimal, no imports) loads and logs `SmokePlugin initialized` — (proven: DEBUGGING.md step 5)
- F2: `file://` plugin mechanism works — (proven: smoke and webtools both load via it)
- F3: Config is being read — (proven: smoke loads from same config file)
- F4: `index.ts` and `smoke.ts` are both registered in `opencode.json` `.plugin` array — (proven: inspected config)
- F5: `smoke.ts` now defines a `task` tool with description `"SMOKE_SHADOW_CONFIRMED"` — (proven: read the file)
- F6: Step 1 of the smoke shadow test (run live, check if `task` shadow appears) has **never been executed** — (proven: DEBUGGING.md line 75)
- F7: `index.ts` exports `ZZZTestLoadPlugin` and defines a tool named `zzztest_task_loaded` — (proven: read the file)
- F8: `bun run src/smoke.ts` and `bun run src/index.ts` both exit without error — (proven: ran both)
- F9: F8 tells us nothing about OpenCode's plugin host runtime — (inferred: OpenCode runs plugins in its own Bun context, not plain `bun run`)

---

## Hypotheses

| ID  | Hypothesis                                                                         | Status | Evidence For                                           | Evidence Against               |
| --- | ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ | ------------------------------ |
| H1  | Tool shadowing is impossible in OpenCode's plugin system                           | active | task tool always shows built-in                        | Not yet tested                 |
| H2  | `index.ts` throws a silent error in OpenCode's runtime (e.g. `node:` imports fail) | active | Untested in OpenCode runtime                           | F8: bun run succeeds           |
| H3  | `index.ts` loads fine but the `tool` key is structured incorrectly for shadowing   | active | Tool named `zzztest_task_loaded` never appeared either | -                              |
| H4  | `index.ts` exports are not in the form OpenCode's plugin loader expects            | active | -                                                      | smoke.ts uses same export form |
| H5  | OpenCode loads plugins but deduplication/precedence logic keeps built-in `task`    | active | -                                                      | -                              |

---

## Experiments (Needed)

| ID  | Experiment                                                                              | Tests | Expected if true                      | How to observe                       |
| --- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------- | ------------------------------------ |
| E1  | Run live OpenCode session, check task tool description                                  | H1    | task still shows built-in description | Run session, ask model to list tools |
| E2  | Run live session, check if `zzztest_task_loaded` appears in tool list                   | H3/H4 | Tool absent                           | Same                                 |
| E3  | Add a log line to `index.ts` plugin init (like smoke does), run live                    | H2    | No log line appears                   | OpenCode log output                  |
| E4  | Have smoke.ts `import { ZZZTestLoadPlugin } from "./index.ts"` and try to initialize it | H2    | Import fails silently                 | Smoke log output                     |

---

## Key Open Question

**All four hypotheses require a live OpenCode run to test.** Nothing can be ruled in or out without running OpenCode and observing its output.

The ONLY path forward is: how do I run OpenCode and observe (a) which tools are registered, and (b) whether plugin init logs appear?

Options:

- `opencode run -p "list all your tools"` — captures stdout?
- OpenCode log file at a known path?
- TUI log viewer?

---

## What Is Ruled Out

- Config not read (F3)
- file:// mechanism broken (F2)
- Syntax errors in either file (F8)
- Export name mattering for load (DEBUGGING.md step 4)

---

## Current Best Explanation

(speculation) — H2 or H4. Either `index.ts` errors silently in OpenCode's runtime,
or the plugin loader expects a specific export shape that `index.ts` doesn't match.
But this is speculation without a live run.

---

## Next Action

Ask the user: how do we run OpenCode and observe log output or tool list?
