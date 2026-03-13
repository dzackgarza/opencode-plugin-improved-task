import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OPENCODE = process.env.OPENCODE_BIN || "opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MANAGER_PACKAGE = join(TOOL_DIR, "..", "opencode-manager");
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;
const CUSTOM_CONFIG_AGENT_NAME = "runtime-scout";
const CUSTOM_CONFIG_AGENT_DESCRIPTION =
  "Synthetic config-defined subagent for runtime visibility verification.";
const DIRECT_PRIMARY_AGENT_NAME = "improved-task-proof";
const SHADOW_PRIMARY_AGENT_NAME = "task-proof";

type ToolState = {
  input?: Record<string, unknown>;
  output?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
};

type SessionMessagePart = {
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
};

type SessionMessage = {
  info?: {
    role?: string;
  };
  parts?: SessionMessagePart[];
};

type TranscriptArtifactDocument = {
  sessionID?: string;
  turns?: Array<{
    assistantMessages?: Array<{
      reasoning?: string[];
      steps?: Array<{
        contentText?: string;
      }>;
      text?: string;
    }>;
  }>;
};

type RuntimeSurface = {
  baseUrl: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";
let primaryRuntime: RuntimeSurface | undefined;
let primaryRuntimeCleanup: (() => Promise<void>) | undefined;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createIsolatedRuntime(cwd: string): Promise<{
  runtime: RuntimeSurface;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(systemTmpdir(), "improved-task-opencode-"));
  const configHome = join(root, "config");
  const testHome = join(root, "home");
  await mkdir(configHome, { recursive: true });
  await mkdir(testHome, { recursive: true });
  return {
    runtime: {
      baseUrl: "",
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_TEST_HOME: testHome,
      },
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function resolveDirenvEnv(
  cwdForDirenv: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const result = spawnSync(
    "direnv",
    ["exec", cwdForDirenv, "env", "-0"],
    {
      cwd: cwdForDirenv,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to resolve direnv environment for ${cwdForDirenv}.\nSTDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`,
    );
  }

  const resolved: NodeJS.ProcessEnv = {};
  for (const entry of (result.stdout ?? "").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    resolved[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return resolved;
}

async function startServer() {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
  const isolated = await createIsolatedRuntime(TOOL_DIR);
  const resolvedEnv = await resolveDirenvEnv(TOOL_DIR, {
    ...isolated.runtime.env,
    OPENCODE_BASE_URL: baseUrl,
  });
  primaryRuntime = {
    ...isolated.runtime,
    baseUrl,
    env: resolvedEnv,
  };
  primaryRuntimeCleanup = isolated.cleanup;
  serverLogs = "";
  serverProcess = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      OPENCODE,
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(serverPort),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: TOOL_DIR,
      env: primaryRuntime.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = `opencode server listening on ${baseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

  const capture = (chunk: Buffer | string) => {
    serverLogs += chunk.toString();
  };
  serverProcess.stdout.on("data", capture);
  serverProcess.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (serverLogs.includes(ready)) {
      return;
    }
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Custom OpenCode server exited early (${serverProcess.exitCode}).\n${serverLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for custom OpenCode server at ${baseUrl}.\n${serverLogs}`,
  );
}

async function stopServer() {
  try {
    if (!serverProcess || serverProcess.exitCode !== null) return;

    serverProcess.kill("SIGINT");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) return;
      await wait(100);
    }

    serverProcess.kill("SIGKILL");
  } finally {
    await primaryRuntimeCleanup?.();
    primaryRuntimeCleanup = undefined;
    primaryRuntime = undefined;
  }
}

function runManager(command: "opx", args: string[]) {
  return runManagerAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    command,
    args,
  );
}

function runManagerAt(
  runtime: RuntimeSurface,
  command: "opx",
  args: string[],
) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, command, ...args],
    {
      cwd: runtime.cwd,
      env: {
        ...runtime.env,
        OPENCODE_BASE_URL: runtime.baseUrl,
      },
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `Manager command failed: ${command} ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return {
    stdout,
    stderr,
  };
}

function parseKeptSessionID(stderr: string) {
  const match = stderr.match(/\[opx\] session kept: (ses_[A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(`Could not parse kept session ID.\n${stderr}`);
  }
  return match[1];
}

function runPrompt(
  prompt: string,
  lingerSeconds = 0,
  agentName = DIRECT_PRIMARY_AGENT_NAME,
) {
  return runPromptAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    agentName,
    prompt,
    lingerSeconds,
  );
}

function runPromptAt(
  runtime: RuntimeSurface,
  agentName: string,
  prompt: string,
  lingerSeconds = 0,
) {
  return runManagerAt(runtime, "opx", [
    "run",
    "--agent",
    agentName,
    "--prompt",
    prompt,
    "--keep",
    "--linger",
    String(lingerSeconds),
  ]);
}

function resumePrompt(
  sessionID: string,
  prompt: string,
  lingerSeconds = 0,
  agentName = DIRECT_PRIMARY_AGENT_NAME,
) {
  return resumePromptAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    agentName,
    sessionID,
    prompt,
    lingerSeconds,
  );
}

function resumePromptAt(
  runtime: RuntimeSurface,
  agentName: string,
  sessionID: string,
  prompt: string,
  lingerSeconds = 0,
) {
  return runManagerAt(runtime, "opx", [
    "resume",
    "--session",
    sessionID,
    "--agent",
    agentName,
    "--prompt",
    prompt,
    "--keep",
    "--linger",
    String(lingerSeconds),
  ]);
}

function safeDeleteSession(sessionID: string | undefined) {
  return safeDeleteSessionAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    sessionID,
  );
}

function safeDeleteSessionAt(
  runtime: RuntimeSurface,
  sessionID: string | undefined,
) {
  if (!sessionID) return;
  try {
    runManagerAt(runtime, "opx", ["session", "delete", "--session", sessionID]);
  } catch {
    // best-effort cleanup in a noisy shared environment
  }
}

function readMessages(sessionID: string): SessionMessage[] {
  return readMessagesAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    sessionID,
  );
}

function readMessagesAt(
  runtime: RuntimeSurface,
  sessionID: string,
): SessionMessage[] {
  const { stdout } = runManagerAt(runtime, "opx", [
    "session",
    "messages",
    "--session",
    sessionID,
  ]);
  return JSON.parse(stdout) as SessionMessage[];
}

function runOpencodeAt(runtime: RuntimeSurface, args: string[]) {
  const result = spawnSync(
    "direnv",
    ["exec", TOOL_DIR, OPENCODE, ...args],
    {
      cwd: runtime.cwd,
      env: runtime.env,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );

  if (result.error) throw result.error;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(
      `OpenCode command failed: ${args.join(" ")}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }

  return {
    stdout,
    stderr,
  };
}

function executionAgentName(toolName: "improved_task" | "task") {
  return toolName === "task"
    ? SHADOW_PRIMARY_AGENT_NAME
    : DIRECT_PRIMARY_AGENT_NAME;
}

function toolParts(
  messages: SessionMessage[],
  toolName: "improved_task" | "task",
) {
  return messages
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool" && part.tool === toolName);
}

function toolOutputs(
  messages: SessionMessage[],
  toolName: "improved_task" | "task",
) {
  return toolParts(messages, toolName)
    .map((part) => part.state?.output)
    .filter((output): output is string => typeof output === "string");
}

function publishedReports(messages: SessionMessage[]) {
  return messages
    .filter((message) => message.info?.role === "user")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .filter((text) => {
      return text.startsWith("---\nsession_id:") && text.includes("## Completion Review");
    });
}

function reportReminders(messages: SessionMessage[]) {
  return messages
    .filter((message) => message.info?.role === "user")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .filter((text) => {
      return text.includes("The subagent results report has already been displayed in chat.");
    });
}

async function waitForToolOutputCount(
  sessionID: string,
  toolName: "improved_task" | "task",
  expectedCount: number,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const outputs = toolOutputs(messages, toolName);
    if (outputs.length >= expectedCount) {
      return { messages, outputs };
    }
    await wait(1_000);
  }

  const messages = readMessages(sessionID);
  throw new Error(
    `Timed out waiting for ${expectedCount} ${toolName} outputs.\n${JSON.stringify(messages, null, 2)}`,
  );
}

async function waitForPublishedReportCount(
  sessionID: string,
  expectedCount: number,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const reports = publishedReports(messages);
    if (reports.length >= expectedCount) {
      return { messages, reports };
    }
    await wait(1_000);
  }

  const messages = readMessages(sessionID);
  throw new Error(
    `Timed out waiting for ${expectedCount} callback reports.\n${JSON.stringify(messages, null, 2)}`,
  );
}

async function waitForReminderCount(
  sessionID: string,
  expectedCount: number,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const reminders = reportReminders(messages);
    if (reminders.length >= expectedCount) {
      return { messages, reminders };
    }
    await wait(1_000);
  }

  const messages = readMessages(sessionID);
  throw new Error(
    `Timed out waiting for ${expectedCount} report reminders.\n${JSON.stringify(messages, null, 2)}`,
  );
}

function parseScalar(rawValue: string): number | string {
  const value = rawValue.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return JSON.parse(value) as string;
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  return value;
}

function parseFrontMatter(report: string) {
  const match = report.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Could not parse report front matter.\n${report}`);
  }

  const metadata = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        if (index < 0) {
          throw new Error(`Invalid front matter line: ${line}`);
        }
        return [
          line.slice(0, index).trim(),
          parseScalar(line.slice(index + 1)),
        ];
      }),
  ) as Record<string, string | number>;

  return {
    metadata,
    body: match[2].replace(/^\n/, ""),
  };
}

function expectedPassphrase(
  toolName: "improved_task" | "task",
  path: "visible" | "sync:new" | "sync:resume" | "async:new" | "async:resume",
  runtime: RuntimeSurface = primaryRuntime ?? {
    baseUrl,
    cwd: TOOL_DIR,
    env: process.env,
  },
) {
  const passphrase = runtime.env.IMPROVED_TASK_TEST_PASSPHRASE ?? "";
  return `Verification passphrase: ${passphrase}:${toolName}:${path}`;
}

function expectedVisiblePassphrase(
  toolName: "improved_task" | "task",
  runtime: RuntimeSurface = primaryRuntime ?? {
    baseUrl,
    cwd: TOOL_DIR,
    env: process.env,
  },
) {
  const passphrase = runtime.env.IMPROVED_TASK_TEST_PASSPHRASE ?? "";
  return `${passphrase}:${toolName}:visible`;
}

function reportSessionID(report: string) {
  const { metadata } = parseFrontMatter(report);
  if (typeof metadata.session_id !== "string") {
    throw new Error(`Missing session_id in report\n${report}`);
  }
  return metadata.session_id;
}

function extractSection(body: string, heading: string, nextHeading?: string) {
  const start = body.indexOf(heading);
  if (start < 0) {
    throw new Error(`Missing section: ${heading}\n${body}`);
  }

  const contentStart = start + heading.length;
  const contentEnd = nextHeading
    ? body.indexOf(nextHeading, contentStart)
    : body.length;
  if (nextHeading && contentEnd < 0) {
    throw new Error(`Missing section boundary: ${nextHeading}\n${body}`);
  }

  return body.slice(contentStart, contentEnd).trim();
}

function lastAssistantText(messages: SessionMessage[]) {
  const assistantMessages = messages.filter((message) => {
    return message.info?.role === "assistant";
  });
  const lastAssistant = assistantMessages.at(-1);
  const text = (lastAssistant?.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  return text.length > 0 ? text : "Subagent completed without a text response.";
}

function childToolNames(messages: SessionMessage[]) {
  return new Set(
    messages
      .filter((message) => message.info?.role === "assistant")
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "tool" && typeof part.tool === "string")
      .map((part) => part.tool as string),
  );
}

function readTranscriptDocument(path: string): TranscriptArtifactDocument {
  return JSON.parse(readFileSync(path, "utf8")) as TranscriptArtifactDocument;
}

function transcriptNarrativeText(document: TranscriptArtifactDocument) {
  return (document.turns ?? [])
    .flatMap((turn) => turn.assistantMessages ?? [])
    .flatMap((message) => [
      ...(message.reasoning ?? []),
      ...(message.steps ?? [])
        .map((step) => step.contentText)
        .filter((value): value is string => typeof value === "string"),
      ...(typeof message.text === "string" ? [message.text] : []),
    ])
    .join("\n");
}

async function waitForAssistantText(sessionID: string, timeoutMs = 60_000) {
  return waitForAssistantTextAt(
    primaryRuntime ?? {
      baseUrl,
      cwd: TOOL_DIR,
      env: process.env,
    },
    sessionID,
    timeoutMs,
  );
}

async function waitForAssistantTextAt(
  runtime: RuntimeSurface,
  sessionID: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessagesAt(runtime, sessionID);
    const assistantMessages = messages.filter((message) => {
      return message.info?.role === "assistant";
    });
    const text = lastAssistantText(messages);
    if (assistantMessages.length > 0 && text !== "Subagent completed without a text response.") {
      return text;
    }
    await wait(1_000);
  }

  const messages = readMessagesAt(runtime, sessionID);
  throw new Error(
    `Timed out waiting for assistant text.\n${JSON.stringify(messages, null, 2)}`,
  );
}

function assertHeaderOrder(body: string, headers: string[]) {
  let previousIndex = -1;
  for (const header of headers) {
    const index = body.indexOf(header);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function assertSuccessReport(input: {
  report: string;
  childMessages: SessionMessage[];
  expectedSessionID?: string;
  expectedPassphrasePath:
    | "sync:new"
    | "sync:resume"
    | "async:new"
    | "async:resume";
  toolName: "improved_task" | "task";
}) {
  const { metadata, body } = parseFrontMatter(input.report);

  expect(Object.keys(metadata).sort()).toEqual([
    "num_tool_calls",
    "session_id",
    "time_elapsed",
    "tokens_used",
    "transcript_path",
  ]);
  expect(input.report).not.toContain("status:");
  expect(input.report).not.toContain("cost_usd:");
  expect(input.report).not.toContain("tokens_in:");
  expect(input.report).not.toContain("tokens_out:");
  expect(input.report).not.toContain("duration_ms:");

  expect(typeof metadata.session_id).toBe("string");
  expect(typeof metadata.tokens_used).toBe("number");
  expect(typeof metadata.num_tool_calls).toBe("number");
  expect(typeof metadata.transcript_path).toBe("string");
  expect(typeof metadata.time_elapsed).toBe("string");
  if (input.expectedSessionID) {
    expect(metadata.session_id).toBe(input.expectedSessionID);
  }

  const transcriptPath = metadata.transcript_path as string;
  expect(existsSync(transcriptPath)).toBe(true);
  expect(metadata.tokens_used as number).toBeGreaterThan(0);
  expect(metadata.num_tool_calls as number).toBeGreaterThanOrEqual(0);
  expect(metadata.time_elapsed).toMatch(/^\d+\.\d{3}s$/);

  assertHeaderOrder(body, [
    "## Agent's Last Message",
    "## Turn-by-Turn Summary",
    "## Completion Review",
  ]);
  expect(
    extractSection(
      body,
      "## Agent's Last Message",
      "## Turn-by-Turn Summary",
    ),
  ).toBe(lastAssistantText(input.childMessages));
  expect(body).toContain("- Turns observed:");
  expect(body).toContain("- Reasoning parts observed:");
  expect(body).toContain("  - delegation:");
  expect(body).toContain("  - filesystem:");
  expect(body).toContain("  - memory:");
  expect(body).toContain("  - shell:");
  expect(body).toContain("  - web:");
  expect(body).toContain("  - other:");
  expect(body).toContain("### Observed Counts");
  expect(body).toContain("- Outcome:");
  expect(body).toContain("- Completion confidence score:");
  expect(body).toContain("Transcript saved to:");
  expect(input.report).toContain(
    expectedPassphrase(input.toolName, input.expectedPassphrasePath),
  );

  const actualTools = childToolNames(input.childMessages);
  if (actualTools.size > 0) {
    const summarizedTools = body
      .split("\n")
      .filter((line) => line.startsWith("- Tool "))
      .map((line) => line.replace(/^- Tool ([^:]+):.*$/, "$1").trim());
    expect(summarizedTools.length).toBeGreaterThan(0);
    expect(summarizedTools.some((tool) => actualTools.has(tool))).toBe(true);
  }

  const transcript = readTranscriptDocument(transcriptPath);
  expect(transcript.sessionID).toBe(reportSessionID(input.report));
  expect(transcriptNarrativeText(transcript)).toContain(
    lastAssistantText(input.childMessages),
  );

  return metadata;
}

function assertRunningNotice(input: {
  report: string;
  expectedSessionID?: string;
}) {
  const { metadata, body } = parseFrontMatter(input.report);

  expect(metadata.status).toBe("running");
  expect(typeof metadata.session_id).toBe("string");
  if (input.expectedSessionID) {
    expect(metadata.session_id).toBe(input.expectedSessionID);
  }
  expect(body).toContain("Task is running in the background.");
  return metadata.session_id as string;
}

function assertPublishedReportNotice(input: {
  output: string;
  expectedSessionID?: string;
}) {
  const { metadata, body } = parseFrontMatter(input.output);

  expect(metadata.report_published).toBe("true");
  expect(typeof metadata.session_id).toBe("string");
  if (input.expectedSessionID) {
    expect(metadata.session_id).toBe(input.expectedSessionID);
  }
  expect(body).toBe("The full subagent results report has been published in chat.");
  expect(input.output).not.toContain("## Completion Review");
  return metadata.session_id as string;
}

function assertTaskDisplayMetadata(
  part: SessionMessagePart | undefined,
  expectedSessionID: string,
) {
  expect(part?.state?.title).toBe(part?.state?.input?.description);
  expect(part?.state?.metadata).toMatchObject({
    sessionId: expectedSessionID,
  });
}

function lifecyclePrompt(input: {
  toolName: "improved_task" | "task";
  mode: "sync" | "async";
  sessionID?: string;
}) {
  const sessionClause = input.sessionID
    ? ` and session_id=${input.sessionID}`
    : "";
  return [
    `Use ${input.toolName} exactly once with mode=${input.mode} and subagent_type general${sessionClause}.`,
    "In the child session, read README.md and answer with its first markdown heading in one short sentence.",
    "After the tool finishes, answer with ONLY OK.",
    `Do not inspect or use any tool other than ${input.toolName}.`,
  ].join(" ");
}

function visibilityPassphrasePrompt(
  toolName: "improved_task" | "task",
  missingSentinel = "NO_VISIBLE_PASSPHRASE",
) {
  return [
    `Reply with EXACTLY either the verification passphrase from the ${toolName} tool description,`,
    `or the exact string "${missingSentinel}" if no such line exists.`,
    `Do not call ${toolName} or any other tool.`,
    "Do not add quotes, code fences, or extra text.",
  ].join(" ");
}

function schemaAgentLinePrompt(
  toolName: "improved_task" | "task",
  agentName = "general",
  missingSentinel = "NO_AGENT",
) {
  return [
    `Reply with EXACTLY either the line that starts with "- ${agentName}:" from the ${toolName} tool description,`,
    `or the exact string "${missingSentinel}" if no such line exists.`,
    `Do not call ${toolName} or any other tool.`,
    "Do not add quotes, code fences, or extra text.",
  ].join(" ");
}

async function expectToolVisibilityPassphrase(toolName: "improved_task" | "task") {
  let sessionID: string | undefined;

  try {
    const run = runPrompt(
      visibilityPassphrasePrompt(toolName),
      0,
      executionAgentName(toolName),
    );
    sessionID = parseKeptSessionID(run.stderr);

    const response = await waitForAssistantText(sessionID);

    expect(response).not.toBe("NO_VISIBLE_PASSPHRASE");
    expect(response).toBe(expectedVisiblePassphrase(toolName));
  } finally {
    safeDeleteSession(sessionID);
  }
}

async function createCustomConfigWorkspace() {
  const cwd = await mkdtemp(join(systemTmpdir(), "improved-task-runtime-"));
  await mkdir(join(cwd, ".opencode", "plugin"), { recursive: true });
  await writeFile(
    join(cwd, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        agent: {
          [CUSTOM_CONFIG_AGENT_NAME]: {
            description: CUSTOM_CONFIG_AGENT_DESCRIPTION,
            mode: "subagent",
            prompt: "You are a synthetic runtime-only subagent used for integration tests.",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(cwd, ".opencode", "plugin", "improved-task.ts"),
    [
      "export { ImprovedTaskPlugin as default } from",
      `${JSON.stringify(pathToFileURL(join(TOOL_DIR, "src/index.ts")).href)};`,
      "",
    ].join(" "),
    "utf8",
  );
  return {
    cwd,
    [Symbol.asyncDispose]: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function startWorkspaceServer(runtime: RuntimeSurface) {
  const port = await findFreePort();
  const workspaceBaseUrl = `http://${HOST}:${port}`;
  let workspaceLogs = "";
  const resolvedEnv = await resolveDirenvEnv(TOOL_DIR, {
    ...runtime.env,
    OPENCODE_BASE_URL: workspaceBaseUrl,
  });
  const child = spawn(
    "direnv",
    [
      "exec",
      TOOL_DIR,
      OPENCODE,
      "serve",
      "--hostname",
      HOST,
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: runtime.cwd,
      env: resolvedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = `opencode server listening on ${workspaceBaseUrl}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  const capture = (chunk: Buffer | string) => {
    workspaceLogs += chunk.toString();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  while (Date.now() < deadline) {
    if (workspaceLogs.includes(ready)) {
      return {
        process: child,
        logs: () => workspaceLogs,
        baseUrl: workspaceBaseUrl,
        env: resolvedEnv,
      };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Workspace OpenCode server exited early (${child.exitCode}).\n${workspaceLogs}`,
      );
    }
    await wait(200);
  }

  throw new Error(
    `Timed out waiting for workspace OpenCode server at ${workspaceBaseUrl}.\n${workspaceLogs}`,
  );
}

async function stopWorkspaceServer(process: ChildProcess | undefined) {
  if (!process || process.exitCode !== null) return;

  process.kill("SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) return;
    await wait(100);
  }

  process.kill("SIGKILL");
}

async function expectCustomConfigAgentVisibleAcrossRuntimeSurfaces() {
  await using workspace = await createCustomConfigWorkspace();
  let sessionID: string | undefined;
  let workspaceProcess: ChildProcess | undefined;
  let workspaceRuntime: RuntimeSurface | undefined;
  let cleanupWorkspaceRuntime: (() => Promise<void>) | undefined;

  try {
    const isolated = await createIsolatedRuntime(workspace.cwd);
    cleanupWorkspaceRuntime = isolated.cleanup;
    workspaceRuntime = isolated.runtime;

    const listed = runOpencodeAt(
      workspaceRuntime,
      ["agent", "list"],
    );
    expect(listed.stdout).toContain(`${CUSTOM_CONFIG_AGENT_NAME} (subagent)`);

    const started = await startWorkspaceServer(workspaceRuntime);
    workspaceProcess = started.process;
    workspaceRuntime = {
      ...workspaceRuntime,
      baseUrl: started.baseUrl,
      env: started.env,
    };

    for (const toolName of ["improved_task", "task"] as const) {
      const run = runPromptAt(
        workspaceRuntime,
        "build",
        schemaAgentLinePrompt(
          toolName,
          CUSTOM_CONFIG_AGENT_NAME,
          "NO_CUSTOM_CONFIG_AGENT",
        ),
      );
      sessionID = parseKeptSessionID(run.stderr);

      const response = await waitForAssistantTextAt(
        workspaceRuntime,
        sessionID,
      );

      expect(response).not.toBe("NO_CUSTOM_CONFIG_AGENT");
      expect(response).toContain(`- ${CUSTOM_CONFIG_AGENT_NAME}:`);
      expect(response).toContain(CUSTOM_CONFIG_AGENT_DESCRIPTION);

      safeDeleteSessionAt(workspaceRuntime, sessionID);
      sessionID = undefined;
    }
  } finally {
    if (workspaceRuntime) {
      safeDeleteSessionAt(workspaceRuntime, sessionID);
    }
    await stopWorkspaceServer(workspaceProcess);
    await cleanupWorkspaceRuntime?.();
  }
}

async function expectSyncLifecycleReport(toolName: "improved_task" | "task") {
  let parentSessionID: string | undefined;
  let childSessionID: string | undefined;

  try {
    const firstRun = runPrompt(
      lifecyclePrompt({
        toolName,
        mode: "sync",
      }),
      0,
      executionAgentName(toolName),
    );
    parentSessionID = parseKeptSessionID(firstRun.stderr);

    const firstResult = await waitForToolOutputCount(parentSessionID, toolName, 1);
    const firstPublished = await waitForPublishedReportCount(parentSessionID, 1);
    childSessionID = reportSessionID(firstPublished.reports[0]);
    assertPublishedReportNotice({
      output: firstResult.outputs[0],
      expectedSessionID: childSessionID,
    });
    assertTaskDisplayMetadata(
      toolParts(firstResult.messages, toolName)[0],
      childSessionID,
    );
    const firstMetadata = assertSuccessReport({
      report: firstPublished.reports[0],
      childMessages: readMessages(childSessionID),
      expectedPassphrasePath: "sync:new",
      toolName,
    });
    const firstReminder = await waitForReminderCount(parentSessionID, 1);
    expect(firstReminder.reminders[0]).toContain(
      "The subagent results report has already been displayed in chat.",
    );
    childSessionID = firstMetadata.session_id as string;

    resumePrompt(
      parentSessionID,
      lifecyclePrompt({
        toolName,
        mode: "sync",
        sessionID: childSessionID,
      }),
      0,
      executionAgentName(toolName),
    );

    const secondResult = await waitForToolOutputCount(parentSessionID, toolName, 2);
    const secondPublished = await waitForPublishedReportCount(parentSessionID, 2);
    assertPublishedReportNotice({
      output: secondResult.outputs[1],
      expectedSessionID: childSessionID,
    });
    assertTaskDisplayMetadata(
      toolParts(secondResult.messages, toolName)[1],
      childSessionID,
    );
    const secondChildMessages = readMessages(childSessionID);
    assertSuccessReport({
      report: secondPublished.reports[1],
      childMessages: secondChildMessages,
      expectedSessionID: childSessionID,
      expectedPassphrasePath: "sync:resume",
      toolName,
    });
    const secondReminder = await waitForReminderCount(parentSessionID, 2);
    expect(secondReminder.reminders[1]).toContain(
      "The subagent results report has already been displayed in chat.",
    );
  } finally {
    safeDeleteSession(childSessionID);
    safeDeleteSession(parentSessionID);
  }
}

async function expectAsyncLifecycleReport(toolName: "improved_task" | "task") {
  let parentSessionID: string | undefined;
  let childSessionID: string | undefined;

  try {
    const firstRun = runPrompt(
      lifecyclePrompt({
        toolName,
        mode: "async",
      }),
      30,
      executionAgentName(toolName),
    );
    parentSessionID = parseKeptSessionID(firstRun.stderr);

    const firstToolResult = await waitForToolOutputCount(
      parentSessionID,
      toolName,
      1,
    );
    childSessionID = assertRunningNotice({
      report: firstToolResult.outputs[0],
    });
    assertTaskDisplayMetadata(
      toolParts(firstToolResult.messages, toolName)[0],
      childSessionID,
    );

    const firstCallback = await waitForPublishedReportCount(parentSessionID, 1);
    assertSuccessReport({
      report: firstCallback.reports[0],
      childMessages: readMessages(childSessionID),
      expectedSessionID: childSessionID,
      expectedPassphrasePath: "async:new",
      toolName,
    });
    const firstReminder = await waitForReminderCount(parentSessionID, 1);
    expect(firstReminder.reminders[0]).toContain(
      "The subagent results report has already been displayed in chat.",
    );

    resumePrompt(
      parentSessionID,
      lifecyclePrompt({
        toolName,
        mode: "async",
        sessionID: childSessionID,
      }),
      30,
      executionAgentName(toolName),
    );

    const secondToolResult = await waitForToolOutputCount(
      parentSessionID,
      toolName,
      2,
    );
    assertRunningNotice({
      report: secondToolResult.outputs[1],
      expectedSessionID: childSessionID,
    });
    assertTaskDisplayMetadata(
      toolParts(secondToolResult.messages, toolName)[1],
      childSessionID,
    );

    const secondCallback = await waitForPublishedReportCount(parentSessionID, 2);
    assertSuccessReport({
      report: secondCallback.reports[1],
      childMessages: readMessages(childSessionID),
      expectedSessionID: childSessionID,
      expectedPassphrasePath: "async:resume",
      toolName,
    });
    const secondReminder = await waitForReminderCount(parentSessionID, 2);
    expect(secondReminder.reminders[1]).toContain(
      "The subagent results report has already been displayed in chat.",
    );
  } finally {
    safeDeleteSession(childSessionID);
    safeDeleteSession(parentSessionID);
  }
}

async function expectInvalidSessionFallback() {
  let parentSessionID: string | undefined;
  let childSessionID: string | undefined;
  const invalidSessionID = "ses_INVALID_CHILD_SESSION_20260311";

  try {
    const run = runPrompt(
      lifecyclePrompt({
        toolName: "improved_task",
        mode: "sync",
        sessionID: invalidSessionID,
      }),
      0,
      executionAgentName("improved_task"),
    );
    parentSessionID = parseKeptSessionID(run.stderr);

    const result = await waitForToolOutputCount(parentSessionID, "improved_task", 1);
    const published = await waitForPublishedReportCount(parentSessionID, 1);
    const firstToolPart = toolParts(result.messages, "improved_task")[0];
    expect(firstToolPart.state?.input?.session_id).toBe(invalidSessionID);
    childSessionID = reportSessionID(published.reports[0]);
    assertPublishedReportNotice({
      output: result.outputs[0],
      expectedSessionID: childSessionID,
    });
    assertTaskDisplayMetadata(firstToolPart, childSessionID);

    const metadata = assertSuccessReport({
      report: published.reports[0],
      childMessages: readMessages(childSessionID),
      expectedPassphrasePath: "sync:new",
      toolName: "improved_task",
    });
    childSessionID = metadata.session_id as string;
    expect(childSessionID).not.toBe(invalidSessionID);
  } finally {
    safeDeleteSession(childSessionID);
    safeDeleteSession(parentSessionID);
  }
}

beforeAll(async () => {
  await startServer();
}, SERVER_START_TIMEOUT_MS + 10_000);

afterAll(async () => {
  await stopServer();
}, 15_000);

describe("improved-task live report contract", () => {
  it("proves config-defined subagents appear in opencode agent list and plugin schemas", async () => {
    await expectCustomConfigAgentVisibleAcrossRuntimeSurfaces();
  }, 180_000);

  it("proves improved_task visibility via the tool-description passphrase", async () => {
    await expectToolVisibilityPassphrase("improved_task");
  }, 120_000);

  it("proves task visibility via the tool-description passphrase", async () => {
    await expectToolVisibilityPassphrase("task");
  }, 120_000);

  it("proves improved_task sync report contract and resume", async () => {
    await expectSyncLifecycleReport("improved_task");
  }, 220_000);

  it("proves improved_task async running notice and callback report", async () => {
    await expectAsyncLifecycleReport("improved_task");
  }, 240_000);

  it("proves task sync report contract and resume", async () => {
    await expectSyncLifecycleReport("task");
  }, 220_000);

  it("proves task async running notice and callback report", async () => {
    await expectAsyncLifecycleReport("task");
  }, 240_000);

  it("proves invalid session_id falls back to a new child session", async () => {
    await expectInvalidSessionFallback();
  }, 220_000);
});
