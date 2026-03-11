import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const OPENCODE =
  process.env.OPENCODE_BIN || "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = process.cwd();
const HOST = "127.0.0.1";
const MANAGER_PACKAGE =
  "git+ssh://git@github.com/dzackgarza/opencode-manager.git";
const SEED = "SWORDFISH-TASK";
const MAX_BUFFER = 8 * 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 60_000;
const SESSION_TIMEOUT_MS = 240_000;

type SessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  }>;
};

let baseUrl = "";
let serverPort = 0;
let serverProcess: ChildProcess | undefined;
let serverLogs = "";

function pass(tool: string, path: string) {
  return `${SEED}:${tool}:${path}`;
}

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

function assistantText(messages: SessionMessage[]) {
  return messages
    .filter((message) => message.info?.role === "assistant")
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function waitForAssistantPassphrases(
  sessionID: string,
  expected: string[],
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = readMessages(sessionID);
    const text = assistantText(messages);
    if (expected.every((needle) => text.includes(needle))) {
      return text;
    }
    await wait(1_000);
  }

  const messages = readMessages(sessionID);
  throw new Error(
    `Timed out waiting for ${expected.join(", ")}.\n${JSON.stringify(messages, null, 2)}`,
  );
}

async function waitForSessionIDLine(
  sessionID: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  const pattern = /SESSION_ID=(ses_[A-Za-z0-9]+)/;

  while (Date.now() < deadline) {
    const text = assistantText(readMessages(sessionID));
    const match = text.match(pattern);
    if (match) return match[1];
    await wait(1_000);
  }

  const messages = readMessages(sessionID);
  throw new Error(
    `Timed out waiting for SESSION_ID=... in assistant text.\n${JSON.stringify(messages, null, 2)}`,
  );
}

async function expectOneTurnToProducePassphrases(input: {
  prompt: string;
  expected: string[];
  lingerSeconds?: number;
}) {
  let sessionID: string | undefined;
  try {
    const result = runPrompt(input.prompt, input.lingerSeconds ?? 0);
    sessionID = parseKeptSessionID(result.stderr);
    const text = await waitForAssistantPassphrases(sessionID, input.expected);
    for (const needle of input.expected) {
      expect(text).toContain(needle);
    }
  } finally {
    safeDeleteSession(sessionID);
  }
}

async function expectTwoTurnLifecycle(input: {
  toolName: "improved_task" | "task";
  mode: "sync" | "async";
}) {
  let parentSessionID: string | undefined;
  let childSessionID: string | undefined;
  const firstPassphrase = pass(input.toolName, `${input.mode}:new`);
  const secondPassphrase = pass(input.toolName, `${input.mode}:resume`);
  const lingerSeconds = input.mode === "async" ? 30 : 0;

  const firstPrompt = [
    `Use ${input.toolName} exactly once with mode=${input.mode} and subagent_type general.`,
    "Create a new child session and complete one short task.",
    "After the tool finishes, reply with ONLY the verification passphrase from the tool result on the first line.",
    "On the second line, reply with SESSION_ID=<the returned session_id>.",
    `Do not inspect or use any tool other than ${input.toolName}.`,
  ].join(" ");

  try {
    const firstRun = runPrompt(firstPrompt, lingerSeconds);
    parentSessionID = parseKeptSessionID(firstRun.stderr);

    const firstText = await waitForAssistantPassphrases(parentSessionID, [
      firstPassphrase,
    ]);
    expect(firstText).toContain(firstPassphrase);

    childSessionID = await waitForSessionIDLine(parentSessionID);

    const secondPrompt = [
      `Use ${input.toolName} exactly once with mode=${input.mode}, subagent_type general, and session_id=${childSessionID}.`,
      "Resume that same child session for one short task.",
      "After the tool finishes, reply with ONLY the verification passphrase from the tool result.",
      `Do not inspect or use any tool other than ${input.toolName}.`,
    ].join(" ");

    resumePrompt(parentSessionID, secondPrompt, lingerSeconds);
    const secondText = await waitForAssistantPassphrases(parentSessionID, [
      secondPassphrase,
    ]);
    expect(secondText).toContain(secondPassphrase);
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

describe("improved-task live e2e", () => {
  it("proves improved_task visibility", async () => {
    await expectOneTurnToProducePassphrases({
      prompt:
        "If you can see a tool named improved_task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE.",
      expected: [pass("improved_task", "visible")],
    });
  }, 200_000);

  it("proves improved_task sync new and resume", async () => {
    await expectTwoTurnLifecycle({
      toolName: "improved_task",
      mode: "sync",
    });
  }, 220_000);

  it("proves improved_task async new and resume", async () => {
    await expectTwoTurnLifecycle({ toolName: "improved_task", mode: "async" });
  }, 240_000);

  it("proves task shadow visibility", async () => {
    await expectOneTurnToProducePassphrases({
      prompt:
        "If you can see a tool named task and its description includes a verification passphrase, reply with ONLY that passphrase. Otherwise reply with ONLY NONE.",
      expected: [pass("task", "visible")],
    });
  }, 200_000);

  it("proves task sync new and resume", async () => {
    await expectTwoTurnLifecycle({ toolName: "task", mode: "sync" });
  }, 220_000);

  it("proves task async new and resume", async () => {
    await expectTwoTurnLifecycle({ toolName: "task", mode: "async" });
  }, 240_000);
});
