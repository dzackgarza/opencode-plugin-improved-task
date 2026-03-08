import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const OPENCODE = "/home/dzack/.opencode/bin/opencode";
const OPX = "/home/dzack/ai/opencode/plugins/utilities/harness";
const TOOL_DIR = "/home/dzack/opencode-plugins/improved-task";
const TOOL_CONFIG = `${TOOL_DIR}/.config/opencode.json`;
const SEED = "SWORDFISH-TASK";
const MAX_BUFFER = 8 * 1024 * 1024;

function pass(tool: string, path: string) {
  return `${SEED}:${tool}:${path}`;
}

function run(prompt: string, timeout = 180_000) {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });
  const result = spawnSync(
    "direnv",
    ["exec", TOOL_DIR, OPENCODE, "run", "--agent", "Minimal", prompt],
    { cwd: process.env.HOME, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

function runAsync(prompt: string, timeout = 240_000) {
  const result = spawnSync(
    "bun",
    ["run", "src/cli.ts", "run", "--prompt", prompt, "--agent", "Interactive", "--linger", "90", "--timeout", "240"],
    {
      cwd: OPX,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        OPENCODE_CONFIG: TOOL_CONFIG,
        IMPROVED_TASK_TEST_PASSPHRASE: SEED,
      },
    },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

describe("improved-task live e2e", () => {
  it("proves improved_task visibility", () => {
    const output = run(
      "If you can see a tool named improved_task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE.",
    );
    expect(output).toContain(pass("improved_task", "visible"));
  }, 200_000);

  it("proves improved_task sync new and resume", () => {
    const output = run(
      "Use improved_task with a general subagent to do one short task, then resume the same session for a second short task. After both improved_task calls complete, reply with ONLY the two verification passphrases from those tool results, one per line, in order.",
    );
    expect(output).toContain(pass("improved_task", "sync:new"));
    expect(output).toContain(pass("improved_task", "sync:resume"));
  }, 220_000);

  it("proves improved_task async new and resume", () => {
    const output = runAsync(
      "Use improved_task with a general subagent in async mode for one short task, wait for completion, then resume the same session in async mode for a second short task. After both completions arrive, reply with ONLY the two verification passphrases from those completion messages, one per line, in order.",
    );
    expect(output).toContain(pass("improved_task", "async:new"));
    expect(output).toContain(pass("improved_task", "async:resume"));
  }, 260_000);

  it("proves task shadow visibility", () => {
    const output = run(
      "If you can see a tool named task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE.",
    );
    expect(output).toContain(pass("task", "visible"));
  }, 200_000);
});
