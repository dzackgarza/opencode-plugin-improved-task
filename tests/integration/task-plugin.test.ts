import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const OPENCODE =
  process.env.OPENCODE_BIN || "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MANAGER_PACKAGE =
  "git+ssh://git@github.com/dzackgarza/opencode-manager.git";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;

type ToolState = {
  input?: Record<string, unknown>;
  output?: unknown;
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

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";

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

async function startServer() {
  spawnSync("direnv", ["allow", TOOL_DIR], { cwd: TOOL_DIR, timeout: 30_000 });

  serverPort = await findFreePort();
  baseUrl = `http://${HOST}:${serverPort}`;
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
      env: process.env,
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
  if (!serverProcess || serverProcess.exitCode !== null) return;

  serverProcess.kill("SIGINT");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) return;
    await wait(100);
  }

  serverProcess.kill("SIGKILL");
}

function runManager(command: "opx", args: string[]) {
  const result = spawnSync(
    "npx",
    ["--yes", `--package=${MANAGER_PACKAGE}`, command, ...args],
    {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: baseUrl,
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

function runPrompt(prompt: string, lingerSeconds = 0) {
  return runManager("opx", [
    "run",
    "--agent",
    "Minimal",
    "--prompt",
    prompt,
    "--keep",
    "--linger",
    String(lingerSeconds),
  ]);
}

function resumePrompt(sessionID: string, prompt: string, lingerSeconds = 0) {
  return runManager("opx", [
    "resume",
    "--session",
    sessionID,
    "--agent",
    "Minimal",
    "--prompt",
    prompt,
    "--keep",
    "--linger",
    String(lingerSeconds),
  ]);
}

function safeDeleteSession(sessionID: string | undefined) {
  if (!sessionID) return;
  try {
    runManager("opx", ["session", "delete", "--session", sessionID]);
  } catch {
    // best-effort cleanup in a noisy shared environment
  }
}

function readMessages(sessionID: string): SessionMessage[] {
  const { stdout } = runManager("opx", [
    "session",
    "messages",
    "--session",
    sessionID,
  ]);
  return JSON.parse(stdout) as SessionMessage[];
}

function executionToolNames(toolName: "improved_task" | "task") {
  return toolName === "task"
    ? new Set(["task", "improved_task"])
    : new Set(["improved_task"]);
}

function toolParts(
  messages: SessionMessage[],
  toolName: "improved_task" | "task",
) {
  const toolNames = executionToolNames(toolName);
  return messages
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "tool" && toolNames.has(part.tool ?? ""));
}

function toolOutputs(
  messages: SessionMessage[],
  toolName: "improved_task" | "task",
) {
  return toolParts(messages, toolName)
    .map((part) => part.state?.output)
    .filter((output): output is string => typeof output === "string");
}

function callbackReports(messages: SessionMessage[]) {
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

async function waitForCallbackReportCount(
  sessionID: string,
  expectedCount: number,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const reports = callbackReports(messages);
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
  expectedToken: string;
  expectedSessionID?: string;
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
  expect(body).toContain(input.expectedToken);
  expect(body).toContain("- Turns observed:");
  expect(body).toContain("- Reasoning parts observed:");
  expect(body).toContain("  - delegation:");
  expect(body).toContain("  - filesystem:");
  expect(body).toContain("  - memory:");
  expect(body).toContain("  - shell:");
  expect(body).toContain("  - web:");
  expect(body).toContain("  - other:");
  expect(body).toContain("- Completion confidence score:");
  expect(body).toContain("Transcript saved to:");

  const transcript = readFileSync(transcriptPath, "utf8");
  expect(transcript).toContain(input.expectedToken);

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

function lifecyclePrompt(input: {
  toolName: "improved_task" | "task";
  mode: "sync" | "async";
  token: string;
  sessionID?: string;
}) {
  const sessionClause = input.sessionID
    ? ` and session_id=${input.sessionID}`
    : "";
  return [
    `Use ${input.toolName} exactly once with mode=${input.mode} and subagent_type general${sessionClause}.`,
    `In the child session, reply with ONLY ${input.token}.`,
    "After the tool finishes, answer with ONLY OK.",
    `Do not inspect or use any tool other than ${input.toolName}.`,
  ].join(" ");
}

async function expectSyncLifecycleReport(toolName: "improved_task" | "task") {
  let parentSessionID: string | undefined;
  let childSessionID: string | undefined;
  const firstToken =
    toolName === "improved_task" ? "QX4N7A1P" : "LM2R8C1K";
  const secondToken =
    toolName === "improved_task" ? "QX4N7A2P" : "LM2R8C2K";

  try {
    const firstRun = runPrompt(
      lifecyclePrompt({
        toolName,
        mode: "sync",
        token: firstToken,
      }),
    );
    parentSessionID = parseKeptSessionID(firstRun.stderr);

    const firstResult = await waitForToolOutputCount(parentSessionID, toolName, 1);
    const firstMetadata = assertSuccessReport({
      report: firstResult.outputs[0],
      expectedToken: firstToken,
    });
    const firstPublished = await waitForCallbackReportCount(parentSessionID, 1);
    expect(firstPublished.reports[0]).toBe(firstResult.outputs[0]);
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
        token: secondToken,
        sessionID: childSessionID,
      }),
    );

    const secondResult = await waitForToolOutputCount(parentSessionID, toolName, 2);
    assertSuccessReport({
      report: secondResult.outputs[1],
      expectedToken: secondToken,
      expectedSessionID: childSessionID,
    });
    const secondPublished = await waitForCallbackReportCount(parentSessionID, 2);
    expect(secondPublished.reports[1]).toBe(secondResult.outputs[1]);
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
  const firstToken =
    toolName === "improved_task" ? "QX4N7B1P" : "LM2R8D1K";
  const secondToken =
    toolName === "improved_task" ? "QX4N7B2P" : "LM2R8D2K";

  try {
    const firstRun = runPrompt(
      lifecyclePrompt({
        toolName,
        mode: "async",
        token: firstToken,
      }),
      30,
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

    const firstCallback = await waitForCallbackReportCount(parentSessionID, 1);
    assertSuccessReport({
      report: firstCallback.reports[0],
      expectedToken: firstToken,
      expectedSessionID: childSessionID,
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
        token: secondToken,
        sessionID: childSessionID,
      }),
      30,
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

    const secondCallback = await waitForCallbackReportCount(parentSessionID, 2);
    assertSuccessReport({
      report: secondCallback.reports[1],
      expectedToken: secondToken,
      expectedSessionID: childSessionID,
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
  const token = "ZX8M5F1Q";

  try {
    const run = runPrompt(
      lifecyclePrompt({
        toolName: "improved_task",
        mode: "sync",
        token,
        sessionID: invalidSessionID,
      }),
    );
    parentSessionID = parseKeptSessionID(run.stderr);

    const result = await waitForToolOutputCount(parentSessionID, "improved_task", 1);
    const firstToolPart = toolParts(result.messages, "improved_task")[0];
    expect(firstToolPart.state?.input?.session_id).toBe(invalidSessionID);

    const metadata = assertSuccessReport({
      report: result.outputs[0],
      expectedToken: token,
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
