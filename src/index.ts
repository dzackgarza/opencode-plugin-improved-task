import { type Plugin, tool } from "@opencode-ai/plugin";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const DEFAULT_SUBAGENT_DESCRIPTION =
  "This subagent should only be called manually by the user.";
const IMPROVED_TASK_TEST_PASSPHRASE_ENV = "IMPROVED_TASK_TEST_PASSPHRASE";
const DIRECT_TOOL_NAME = "improved_task";
const SHADOW_TOOL_NAME = "task";

const TASK_DESCRIPTION_BASE =
  "Delegate work to a subagent using native task lifecycle semantics. Use this when you need a specialized subagent to handle scoped work and return a result.";
const AGENT_FETCH_TIMEOUT_MS = 3000;
const SUBAGENT_CACHE_TTL_MS = 60_000;
const ASYNC_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000;

type TaskModelRef = {
  providerID: string;
  modelID: string;
};

type CachedSubagent = {
  name: string;
  description?: string;
  mode?: string;
  model?: TaskModelRef;
  permission?: Array<{
    permission?: string;
  }>;
};

type SessionMessagePart = {
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    input?: unknown;
  };
};

type SessionMessage = {
  info?: {
    role?: string;
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
    };
    cost?: number;
  };
  parts?: SessionMessagePart[];
};

type TaskTerminalSummary = {
  status: "completed" | "timeout";
  sessionID: string;
  subagentType: string;
  subagentModel: string;
  durationMs: number;
  numToolCalls: number;
  transcriptPath: string;
  completionConfidenceScore: number;
  finalResultText: string;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  timeoutMs?: number;
};

type VerificationPath =
  | "visible"
  | "sync:new"
  | "sync:resume"
  | "async:new"
  | "async:resume";

class TaskTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
  }
}

function timeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 1000));
}

function formatSubagentList(subagents: CachedSubagent[]): string {
  if (subagents.length === 0) {
    return "- (No subagents currently discoverable via client.app.agents())";
  }

  return subagents
    .map(
      (subagent) =>
        `- ${subagent.name}: ${subagent.description ?? DEFAULT_SUBAGENT_DESCRIPTION}`,
    )
    .join("\n");
}

function buildPassphrase(toolName: string, path: VerificationPath): string {
  const seed = process.env[IMPROVED_TASK_TEST_PASSPHRASE_ENV]?.trim() ?? "";
  if (!seed) return "";
  return `${seed}:${toolName}:${path}`;
}

function buildTaskToolDescription(
  subagents: CachedSubagent[],
  toolName: string,
): string {
  const lines = [
    TASK_DESCRIPTION_BASE,
    "",
    "Available subagent types and descriptions:",
    formatSubagentList(subagents),
  ];
  const verificationPassphrase = buildPassphrase(toolName, "visible");
  if (verificationPassphrase) {
    lines.push("", `Verification passphrase: ${verificationPassphrase}`);
  }
  return lines.join("\n");
}

function appendVerificationPassphrase(
  lines: string[],
  verificationPassphrase: string,
): string[] {
  if (!verificationPassphrase) return lines;
  return [...lines, "", `Verification passphrase: ${verificationPassphrase}`];
}

function extractText(
  parts: Array<{ type?: string; text?: string }>,
): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}


function formatModelRef(model: TaskModelRef): string {
  return `${model.providerID}/${model.modelID}`;
}

function withTaskDisplayMetadata(input: {
  description: string;
  subagentType: string;
  model: TaskModelRef;
}): string {
  return `${input.description} [with subagent: ${input.subagentType}, ${formatModelRef(input.model)}]`;
}

// TODO: implement a real completion confidence score.
// For now, always returns 1.0 (unimplemented placeholder).
function computeCompletionConfidenceScore(_input: {
  messageCount: number;
  finalText: string;
}): number {
  return 1.0;
}

function buildTaskSummaryOutput(
  summary: TaskTerminalSummary,
  verificationPassphrase: string,
): string {
  const timeoutBlock =
    summary.status === "timeout" && typeof summary.timeoutMs === "number"
      ? [
          "",
          "## Timeout Details",
          `- Configured limit: ${timeoutSeconds(summary.timeoutMs)} seconds`,
          "- The session transcript may include partial progress up to the timeout boundary.",
          "- If provider throughput appears constrained (<10–20 turns/min), rerun with a different model and consult the `model-selection` skill.",
        ]
      : [];

  return appendVerificationPassphrase([
    "---",
    `status: ${summary.status}`,
    `session_id: ${JSON.stringify(summary.sessionID)}`,
    `subagent_type: ${JSON.stringify(summary.subagentType)}`,
    `subagent_model: ${JSON.stringify(summary.subagentModel)}`,
    `duration_ms: ${summary.durationMs}`,
    `num_tool_calls: ${summary.numToolCalls}`,
    `tokens_in: ${summary.totalTokensIn}`,
    `tokens_out: ${summary.totalTokensOut}`,
    `cost_usd: ${summary.totalCost.toFixed(6)}`,
    `transcript_path: ${JSON.stringify(summary.transcriptPath)}`,
    "---",
    "",
    "## Agent's Last Message",
    summary.finalResultText,
    ...timeoutBlock,
    "",
    "## Transcript",
    `Full turn-by-turn transcript saved to: \`${summary.transcriptPath}\``,
    "Read it to debug tool failures, inspect agent reasoning, or verify steps taken.",
    "",
    "## Follow-up",
    `- Resume: call \`task\` again with \`session_id: ${summary.sessionID}\` and a new \`prompt\`.`,
    "- Keep `subagent_type` unchanged when resuming so continuation stays on the same specialist path.",
    "- If the provided `session_id` is invalid, the tool creates a new child session.",
  ], verificationPassphrase).join("\n");
}

function buildAsyncRunningOutput(input: {
  sessionID: string;
  subagentType: string;
  subagentModel: string;
}): string {
  return [
    "---",
    "status: running",
    `session_id: ${JSON.stringify(input.sessionID)}`,
    `subagent_type: ${JSON.stringify(input.subagentType)}`,
    `subagent_model: ${JSON.stringify(input.subagentModel)}`,
    "---",
    "",
    "## Agent's Last Message",
    "Task is running in the background. A callback will deliver the final report when complete.",
    "",
    "## Follow-up",
    `- Monitor progress by opening child session \`${input.sessionID}\` in the TUI session tree.`,
    `- Resume: call \`task\` again with \`session_id: ${input.sessionID}\` and a new \`prompt\`.`,
  ].join("\n");
}

function buildAsyncHeartbeat(input: {
  sessionID: string;
  subagentType: string;
  elapsedMs: number;
}): string {
  return [
    "[task_async_heartbeat]",
    "status: running",
    `session_id: ${input.sessionID}`,
    `subagent_type: ${input.subagentType}`,
    `elapsed_ms: ${input.elapsedMs}`,
  ].join("\n");
}

function buildAsyncFailureOutput(input: {
  sessionID: string;
  subagentType: string;
  subagentModel: string;
  elapsedMs: number;
  errorMessage: string;
}, verificationPassphrase: string): string {
  return appendVerificationPassphrase([
    "---",
    "status: failed",
    `session_id: ${JSON.stringify(input.sessionID)}`,
    `subagent_type: ${JSON.stringify(input.subagentType)}`,
    `subagent_model: ${JSON.stringify(input.subagentModel)}`,
    `duration_ms: ${input.elapsedMs}`,
    "---",
    "",
    "## Agent's Last Message",
    `Task failed with error: ${input.errorMessage}`,
    "",
    "## Follow-up",
    `- Inspect child session \`${input.sessionID}\` in TUI for detailed failure context.`,
    `- Resume: call \`task\` again with \`session_id: ${input.sessionID}\` and corrective instructions.`,
  ], verificationPassphrase).join("\n");
}

const TRANSCRIPT_SCRIPT = `${process.env["HOME"] ?? "/root"}/.agents/skills/reading-transcripts/scripts/parse_transcript.py`;

async function saveTranscriptFile(sessionID: string): Promise<string> {
  const outPath = join(
    tmpdir(),
    `opencode-task-${sessionID}-${Date.now()}.transcript.md`,
  );
  try {
    const { stdout } = await execFileAsync("python", [
      TRANSCRIPT_SCRIPT,
      "--harness",
      "opencode",
      sessionID,
    ]);
    await fs.writeFile(outPath, stdout, "utf8");
  } catch {
    await fs.writeFile(
      outPath,
      `# Transcript unavailable\nSession ID: ${sessionID}\n`,
      "utf8",
    );
  }
  return outPath;
}

function accumulateTokens(messages: SessionMessage[]): {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
} {
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCost = 0;
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;
    totalTokensIn += msg.info.tokens?.input ?? 0;
    totalTokensOut += msg.info.tokens?.output ?? 0;
    totalCost += msg.info.cost ?? 0;
  }
  return { totalTokensIn, totalTokensOut, totalCost };
}

export const ImprovedTaskPlugin: Plugin = async ({ client }) => {
  let cachedSubagents: CachedSubagent[] = [];
  let cachedAt = 0;
  let shadowDescription = buildTaskToolDescription([], SHADOW_TOOL_NAME);
  let directDescription = buildTaskToolDescription([], DIRECT_TOOL_NAME);

  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await client.app.log({
        body: {
          service: "task-plugin",
          level,
          message,
          extra,
        },
      });
    } catch {
      // Never break execution on logging failures.
    }
  };

  const withTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void | Promise<void>,
  ): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        void Promise.resolve(onTimeout?.()).finally(() => {
          reject(new TaskTimeoutError(label, timeoutMs));
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  const fetchSubagents = async (
    reason: string,
    force = false,
  ): Promise<CachedSubagent[]> => {
    const cacheAgeMs = Date.now() - cachedAt;
    if (
      !force &&
      cachedSubagents.length > 0 &&
      cacheAgeMs < SUBAGENT_CACHE_TTL_MS
    ) {
      return cachedSubagents;
    }

    let agentList: Array<{
      name: string;
      description?: string;
      mode?: string;
      model?: TaskModelRef;
    }> = [];
    try {
      const response = await withTimeout(
        client.app.agents(),
        AGENT_FETCH_TIMEOUT_MS,
        "client.app.agents()",
      );
      const data = response.data;
      if (!Array.isArray(data)) {
        await log("warn", "Agent list unavailable; using cached subagents", {
          reason,
          hasCache: cachedSubagents.length > 0,
        });
        return cachedSubagents;
      }
      agentList = data.map((agent) => ({
        name: agent.name,
        description:
          typeof agent.description === "string" ? agent.description : undefined,
        mode: typeof agent.mode === "string" ? agent.mode : undefined,
        model: agent.model
          ? {
              providerID: agent.model.providerID,
              modelID: agent.model.modelID,
            }
          : undefined,
      }));
    } catch (error) {
      await log(
        "warn",
        "Agent fetch timed out/failed; using cached subagents",
        {
          reason,
          hasCache: cachedSubagents.length > 0,
          error: String(error),
        },
      );
      return cachedSubagents;
    }

    const subagents = agentList
      .filter((agent) => agent.mode !== "primary")
      .sort((a, b) => a.name.localeCompare(b.name));

    cachedSubagents = subagents;
    cachedAt = Date.now();
    shadowDescription = buildTaskToolDescription(subagents, SHADOW_TOOL_NAME);
    directDescription = buildTaskToolDescription(subagents, DIRECT_TOOL_NAME);
    return subagents;
  };

  const sessionExists = async (id: string): Promise<boolean> => {
    const { data, error } = await client.session.messages({ path: { id } });
    return !error && Array.isArray(data);
  };

  const resolveChildSessionID = async (input: {
    sessionID?: string;
    parentSessionID: string;
    title: string;
  }): Promise<{ sessionID: string; resumed: boolean }> => {
    if (input.sessionID && (await sessionExists(input.sessionID))) {
      return { sessionID: input.sessionID, resumed: true };
    }

    const { data: session, error } = await client.session.create({
      body: {
        title: input.title,
        parentID: input.parentSessionID,
      },
    });

    if (error || !session?.id) {
      throw new Error(`Failed to create child session: ${String(error)}`);
    }

    return { sessionID: session.id, resumed: false };
  };

  const resolveParentModel = async (input: {
    sessionID: string;
    messageID: string;
  }): Promise<TaskModelRef | undefined> => {
    const { data, error } = await client.session.message({
      path: {
        id: input.sessionID,
        messageID: input.messageID,
      },
    });

    if (error || !data || typeof data !== "object") return undefined;

    const info =
      typeof (data as { info?: unknown }).info === "object" &&
      (data as { info?: unknown }).info
        ? ((data as { info: Record<string, unknown> }).info ?? {})
        : {};

    const providerID =
      typeof info.providerID === "string" ? info.providerID : undefined;
    const modelID = typeof info.modelID === "string" ? info.modelID : undefined;
    if (!providerID || !modelID) return undefined;

    return { providerID, modelID };
  };

  const runChildPromptToTerminal = async (input: {
    childSessionID: string;
    subagent: CachedSubagent;
    model: TaskModelRef;
    prompt: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<TaskTerminalSummary> => {
    const abortHandler = async () => {
      await client.session
        .abort({ path: { id: input.childSessionID } })
        .catch(() => {});
    };
    input.abortSignal?.addEventListener("abort", abortHandler);

    try {
      const startedAt = Date.now();
      let text = "";
      let timedOut = false;
      try {
        const promptRequest = client.session.prompt({
          path: { id: input.childSessionID },
          body: {
            agent: input.subagent.name,
            model: input.model,
            parts: [{ type: "text", text: input.prompt }],
          },
        });
        const { data: result, error } =
          typeof input.timeoutMs === "number"
            ? await withTimeout(
                promptRequest,
                input.timeoutMs,
                `Subagent prompt for session ${input.childSessionID}`,
                async () => {
                  await log(
                    "warn",
                    "Subagent prompt timed out; aborting child session",
                    {
                      childSessionID: input.childSessionID,
                      timeoutMs: input.timeoutMs,
                      subagentType: input.subagent.name,
                    },
                  );
                  await client.session
                    .abort({ path: { id: input.childSessionID } })
                    .catch(() => {});
                },
              )
            : await promptRequest;

        if (error) {
          throw new Error(String(error));
        }

        const parts =
          (
            result as
              | { parts?: Array<{ type?: string; text?: string }> }
              | undefined
          )?.parts ?? [];
        text = extractText(parts);
      } catch (error) {
        if (error instanceof TaskTimeoutError) {
          timedOut = true;
          await log("warn", "Subagent timeout reached", {
            childSessionID: input.childSessionID,
            subagentType: input.subagent.name,
            timeoutMs: input.timeoutMs,
          });
        } else {
          throw error;
        }
      }

      const elapsedMs = Date.now() - startedAt;
      const finalResultText = timedOut
        ? [
            `Subagent timeout reached after ${
              typeof input.timeoutMs === "number"
                ? timeoutSeconds(input.timeoutMs)
                : timeoutSeconds(elapsedMs)
            } seconds.`,
            "The session transcript was still captured and may include partial progress up to the timeout boundary.",
          ].join(" ")
        : text.length > 0
          ? text
          : "Subagent completed without a text response.";
      const renderedModel = formatModelRef(input.model);

      const { data: rawMessages, error: messagesError } =
        await client.session.messages({
          path: { id: input.childSessionID },
        });
      if (messagesError || !Array.isArray(rawMessages)) {
        throw new Error(
          `Failed to load child session messages: ${String(messagesError)}`,
        );
      }
      const messages = rawMessages as SessionMessage[];

      let numToolCalls = 0;
      for (const msg of messages) {
        for (const part of msg.parts ?? []) {
          if (part.type === "tool") numToolCalls += 1;
        }
      }

      const { totalTokensIn, totalTokensOut, totalCost } =
        accumulateTokens(messages);

      const transcriptPath = await saveTranscriptFile(input.childSessionID);

      const completionConfidenceScore = computeCompletionConfidenceScore({
        messageCount: messages.length,
        finalText: text,
      });

      await log(
        timedOut ? "warn" : "info",
        timedOut ? "Task timed out" : "Task completed",
        {
          childSessionID: input.childSessionID,
          subagentType: input.subagent.name,
          elapsedMs,
          numToolCalls,
          outputChars: text.length,
          transcriptPath,
          totalTokensIn,
          totalTokensOut,
          totalCost,
          completionConfidenceScore,
          ...(timedOut && typeof input.timeoutMs === "number"
            ? {
                timeoutMs: input.timeoutMs,
                timeoutSeconds: timeoutSeconds(input.timeoutMs),
              }
            : {}),
        },
      );

      return {
        status: timedOut ? "timeout" : "completed",
        sessionID: input.childSessionID,
        subagentType: input.subagent.name,
        subagentModel: renderedModel,
        durationMs: elapsedMs,
        numToolCalls,
        transcriptPath,
        completionConfidenceScore,
        finalResultText,
        totalTokensIn,
        totalTokensOut,
        totalCost,
        ...(timedOut && typeof input.timeoutMs === "number"
          ? { timeoutMs: input.timeoutMs }
          : {}),
      };
    } finally {
      input.abortSignal?.removeEventListener("abort", abortHandler);
    }
  };

  const emitParentCallback = async (input: {
    parentSessionID: string;
    text: string;
    terminal: boolean;
  }): Promise<void> => {
    await client.session.promptAsync({
      path: { id: input.parentSessionID },
      body: {
        noReply: !input.terminal,
        parts: [{ type: "text", text: input.text }],
      },
    });
  };

  const runAsyncLifecycle = async (input: {
    parentSessionID: string;
    childSessionID: string;
    subagent: CachedSubagent;
    model: TaskModelRef;
    prompt: string;
    timeoutMs?: number;
    verificationPassphrase: string;
  }): Promise<void> => {
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const heartbeatText = buildAsyncHeartbeat({
        sessionID: input.childSessionID,
        subagentType: input.subagent.name,
        elapsedMs: Date.now() - startedAt,
      });
      void emitParentCallback({
        parentSessionID: input.parentSessionID,
        text: heartbeatText,
        terminal: false,
      }).catch(async (error) => {
        await log("warn", "Async heartbeat emit failed", {
          parentSessionID: input.parentSessionID,
          childSessionID: input.childSessionID,
          error: String(error),
        });
      });
    }, ASYNC_HEARTBEAT_INTERVAL_MS);
    (heartbeat as { unref?: () => void }).unref?.();

    try {
      const summary = await runChildPromptToTerminal({
        childSessionID: input.childSessionID,
        subagent: input.subagent,
        model: input.model,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
      });
      await emitParentCallback({
        parentSessionID: input.parentSessionID,
        text: buildTaskSummaryOutput(summary, input.verificationPassphrase),
        terminal: true,
      });
    } catch (error) {
      const failureText = buildAsyncFailureOutput({
        sessionID: input.childSessionID,
        subagentType: input.subagent.name,
        subagentModel: formatModelRef(input.model),
        elapsedMs: Date.now() - startedAt,
        errorMessage: String(error),
      }, input.verificationPassphrase);
      await log("error", "Async task failed", {
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
        error: String(error),
      });
      await emitParentCallback({
        parentSessionID: input.parentSessionID,
        text: failureText,
        terminal: true,
      }).catch(async (emitError) => {
        await log("error", "Async failure callback emit failed", {
          parentSessionID: input.parentSessionID,
          childSessionID: input.childSessionID,
          error: String(emitError),
        });
      });
    } finally {
      clearInterval(heartbeat);
    }
  };

  void fetchSubagents("plugin_init_warmup", false);

  const createTaskTool = (toolName: string, description: string) =>
    tool({
      description,
      args: {
        description: tool.schema
          .string()
          .describe("A short (3-5 words) description of the task"),
        prompt: tool.schema
          .string()
          .describe("The task for the agent to perform"),
        subagent_type: tool.schema
          .string()
          .describe("The type of specialized agent to use for this task"),
        mode: tool.schema
          .string()
          .optional()
          .describe(
            "Execution mode for delegation: `sync` (default, blocking) or `async` (non-blocking background).",
          ),
        timeout_ms: tool.schema
          .number()
          .optional()
          .describe(
            "Hard timeout in milliseconds (default: 1800000 = 30m). Do not usually change this; lower only for finite-turn tasks (roughly 10-20 turns/min) when hangs/provider stalls are suspected. See the `difficulty-and-time-estimation` skill before nontrivial changes.",
          ),
        session_id: tool.schema
          .string()
          .optional()
          .describe(
            "Optional existing session ID to resume instead of creating a new child session.",
          ),
      },
      async execute(args, context) {
        await fetchSubagents("task_execute", true);

        await context.ask({
          permission: "task",
          patterns: [args.subagent_type],
          always: ["*"],
          metadata: {
            description: args.description,
            subagent_type: args.subagent_type,
          },
        });

        const subagent = cachedSubagents.find(
          (agent) => agent.name === args.subagent_type,
        );
        if (!subagent) {
          throw new Error(
            `Unknown agent type: ${args.subagent_type} is not a valid agent type`,
          );
        }

        const childSession = await resolveChildSessionID({
          sessionID: args.session_id,
          parentSessionID: context.sessionID,
          title: `${args.description} (@${subagent.name} subagent)`,
        });

        const parentModel = await resolveParentModel({
          sessionID: context.sessionID,
          messageID: context.messageID,
        });
        const model = subagent.model ?? parentModel;
        if (!model) {
          throw new Error(
            [
              `No model resolved for subagent_type="${args.subagent_type}".`,
              "Set a model on the subagent config or ensure the parent message has model metadata.",
            ].join(" "),
          );
        }

        const displayDescription = withTaskDisplayMetadata({
          description: args.description,
          subagentType: subagent.name,
          model,
        });
        (args as { description: string }).description = displayDescription;

        context.metadata({
          title: displayDescription,
          metadata: {
            sessionId: childSession.sessionID,
            model,
          },
        });

        const mode = args.mode ? args.mode.trim().toLowerCase() : "sync";
        if (mode !== "sync" && mode !== "async") {
          throw new Error(
            `Invalid mode: ${JSON.stringify(args.mode)}. Expected "sync" or "async".`,
          );
        }
        let timeoutMs = DEFAULT_TASK_TIMEOUT_MS;
        if (args.timeout_ms !== undefined) {
          if (!Number.isFinite(args.timeout_ms)) {
            throw new Error(
              `Invalid timeout_ms: ${JSON.stringify(args.timeout_ms)}.`,
            );
          }
          timeoutMs = Math.floor(args.timeout_ms);
          if (timeoutMs <= 0 || timeoutMs > 86_400_000) {
            throw new Error(
              `Invalid timeout_ms: ${JSON.stringify(args.timeout_ms)}. Expected 1..86400000.`,
            );
          }
        }

        const verificationPassphrase = buildPassphrase(
          toolName,
          `${mode}:${childSession.resumed ? "resume" : "new"}` as VerificationPath,
        );

        if (mode === "async") {
          void runAsyncLifecycle({
            parentSessionID: context.sessionID,
            childSessionID: childSession.sessionID,
            subagent,
            model,
            prompt: args.prompt,
            timeoutMs,
            verificationPassphrase,
          });

          await log("info", "Async task dispatched", {
            parentSessionID: context.sessionID,
            childSessionID: childSession.sessionID,
            subagentType: subagent.name,
            timeoutMs,
            toolName,
            resumed: childSession.resumed,
          });

          return buildAsyncRunningOutput({
            sessionID: childSession.sessionID,
            subagentType: subagent.name,
            subagentModel: formatModelRef(model),
          });
        }

        const summary = await runChildPromptToTerminal({
          childSessionID: childSession.sessionID,
          subagent,
          model,
          prompt: args.prompt,
          timeoutMs,
          abortSignal: context.abort,
        });
        return buildTaskSummaryOutput(summary, verificationPassphrase);
      },
    });

  return {
    tool: {
      [DIRECT_TOOL_NAME]: createTaskTool(DIRECT_TOOL_NAME, directDescription),
      [SHADOW_TOOL_NAME]: createTaskTool(SHADOW_TOOL_NAME, shadowDescription),
    },
  };
};
