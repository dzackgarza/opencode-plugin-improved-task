import { describe, expect, it } from "bun:test";

import { taskReportTesting } from "../../src/index";

describe("task report helpers", () => {
  it("summarizes assistant session data into tool categories and reasoning counts", () => {
    const summary = taskReportTesting.summarizeSessionMessages([
      {
        info: {
          role: "assistant",
          tokens: { total: 19 },
        },
        parts: [
          { type: "reasoning", text: "first pass" },
          { type: "tool", tool: "task" },
          { type: "tool", tool: "bash" },
          { type: "tool", tool: "read" },
        ],
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 3, output: 5 },
        },
        parts: [
          { type: "analysis.reasoning", text: "second pass" },
          { type: "tool", tool: "query_memories" },
          { type: "tool", tool: "webfetch" },
          { type: "tool", tool: "custom_thing" },
        ],
      },
      {
        info: {
          role: "user",
        },
        parts: [{ type: "text", text: "follow up" }],
      },
    ]);

    expect(summary.tokensUsed).toBe(27);
    expect(summary.numToolCalls).toBe(6);
    expect(summary.turnSummary.turnCount).toBe(3);
    expect(summary.turnSummary.reasoningPartCount).toBe(2);
    expect(summary.turnSummary.toolUsesByType).toEqual({
      delegation: 1,
      filesystem: 1,
      memory: 1,
      shell: 1,
      web: 1,
      other: 1,
    });
  });

  it("renders the success report as yaml front matter plus markdown sections", () => {
    const report = taskReportTesting.buildTaskSummaryOutput(
      {
        sessionID: "ses_summary_contract",
        subagentType: "general",
        subagentModel: "openai/gpt-5.2-codex",
        timeElapsedMs: 3210,
        tokensUsed: 44,
        numToolCalls: 3,
        transcriptPath: "/tmp/task-contract.md",
        completionConfidenceScore: 0.9,
        finalResultText: "QJ7K2M1R",
        turnSummary: {
          turnCount: 4,
          reasoningPartCount: 2,
          toolUsesByType: {
            delegation: 1,
            filesystem: 1,
            memory: 0,
            shell: 1,
            web: 0,
            other: 0,
          },
        },
      },
      "",
    );

    expect(report).toContain('session_id: "ses_summary_contract"');
    expect(report).toContain("tokens_used: 44");
    expect(report).toContain("num_tool_calls: 3");
    expect(report).toContain('transcript_path: "/tmp/task-contract.md"');
    expect(report).toContain('time_elapsed: "3.210s"');
    expect(report).not.toContain("status:");
    expect(report).not.toContain("cost_usd:");
    expect(report).toContain("## Agent's Last Message");
    expect(report).toContain("QJ7K2M1R");
    expect(report).toContain("## Turn-by-Turn Summary");
    expect(report).toContain("- Turns observed: 4");
    expect(report).toContain("- Reasoning parts observed: 2");
    expect(report).toContain("  - delegation: 1");
    expect(report).toContain("  - filesystem: 1");
    expect(report).toContain("  - memory: 0");
    expect(report).toContain("  - shell: 1");
    expect(report).toContain("  - web: 0");
    expect(report).toContain("  - other: 0");
    expect(report).toContain("## Completion Review");
    expect(report).toContain("- Completion confidence score: 0.90");
    expect(report).toContain("`/tmp/task-contract.md`");
  });
});
