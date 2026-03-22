import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function requireEnv(name: string, message: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

const BASE_URL = requireEnv(
  'OPENCODE_BASE_URL',
  'OPENCODE_BASE_URL must be set (run against a repo-local or CI OpenCode server)',
);
const PASSPHRASE = requireEnv(
  'IMPROVED_TASK_TEST_PASSPHRASE',
  'IMPROVED_TASK_TEST_PASSPHRASE must be set (sourced from plugin .envrc)',
);
const PROJECT_DIR = process.cwd();

const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;
const CALLBACK_TIMEOUT_MS = 120_000;
const ASSISTANT_REPLY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const OCM_TOOL_DIR = mkdtempSync(join(tmpdir(), 'ocm-tool-'));
let ocmBinaryPath: string | undefined;

const IMPROVED_TASK_PROOF_AGENT = 'improved-task-proof';
const TASK_PROOF_AGENT = 'task-proof';

type RawSessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  } | null>;
};

afterAll(() => {
  rmSync(OCM_TOOL_DIR, { recursive: true, force: true });
});

function getOcmBinaryPath(): string {
  if (ocmBinaryPath) return ocmBinaryPath;
  const binDir = process.platform === 'win32' ? join(OCM_TOOL_DIR, 'Scripts') : join(OCM_TOOL_DIR, 'bin');
  const candidate = join(binDir, process.platform === 'win32' ? 'ocm.exe' : 'ocm');
  const pythonBinary = join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
  if (!existsSync(candidate)) {
    const createVenv = spawnSync('uv', ['venv', OCM_TOOL_DIR], {
      env: process.env,
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    if (createVenv.error) throw createVenv.error;
    if (createVenv.status !== 0) {
      throw new Error(
        `Failed to create ocm venv\nSTDOUT:\n${createVenv.stdout ?? ''}\nSTDERR:\n${createVenv.stderr ?? ''}`,
      );
    }
    const install = spawnSync(
      'uv',
      ['pip', 'install', '--python', pythonBinary, MANAGER_PACKAGE],
      {
        env: process.env,
        cwd: PROJECT_DIR,
        encoding: 'utf8',
        timeout: SESSION_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0 || !existsSync(candidate)) {
      throw new Error(
        `Failed to install ocm\nSTDOUT:\n${install.stdout ?? ''}\nSTDERR:\n${install.stderr ?? ''}`,
      );
    }
  }
  ocmBinaryPath = candidate;
  return candidate;
}

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    getOcmBinaryPath(),
    args,
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(' ')} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

function beginSession(prompt: string, agent?: string): string {
  const args = agent
    ? ['begin-session', prompt, '--agent', agent, '--json']
    : ['begin-session', prompt, '--json'];
  const { stdout } = runOcm(args);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

function waitIdle(sessionID: string): void {
  runOcm(['wait', sessionID, '--timeout-sec=180']);
}

function extractFrontMatterValue(text: string, key: string): string | undefined {
  const quoted = text.match(new RegExp(`^${key}:\\s*\"([^\"]+)\"$`, 'm'));
  if (quoted) return quoted[1];
  const bare = text.match(new RegExp(`^${key}:\\s*([^\\n]+)$`, 'm'));
  return bare?.[1]?.trim();
}

async function readRawSessionMessages(sessionID: string): Promise<RawSessionMessage[]> {
  const response = await fetch(`${BASE_URL}/session/${sessionID}/message`);
  if (!response.ok) {
    throw new Error(`Failed to load session messages for ${sessionID}: ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Session messages for ${sessionID} were not an array.`);
  }
  return data as RawSessionMessage[];
}

function flattenMessageText(message: RawSessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type?: string; text?: string } =>
        part !== null && typeof part === 'object',
    )
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function expectReminderPrompt(prompt: string): void {
  expect(prompt).toContain('<system-reminder>');
  expect(prompt).toContain('The subagent results report has already been displayed in chat.');
  expect(prompt).toContain('Refer to that displayed report instead of reconstructing it');
  expect(prompt).toContain('</system-reminder>');
}

function expectSummaryReportPrompt(input: {
  report: string;
  childSessionID: string;
  verificationPassphrase: string;
}): void {
  const { report, childSessionID, verificationPassphrase } = input;
  expect(report).not.toContain('[task_failed]');
  expect(report).toContain(`session_id: "${childSessionID}"`);
  expect(report).toContain('tokens_used:');
  expect(report).toContain('num_tool_calls:');
  expect(report).toContain('transcript_path:');
  expect(report).toContain('## Agent\'s Last Message');
  expect(report).toContain('## Turn-by-Turn Summary');
  expect(report).toContain('### Observed Counts');
  expect(report).toContain('## Completion Review');
  expect(report).toContain(`Verification passphrase: ${verificationPassphrase}`);

  const transcriptPath = extractFrontMatterValue(report, 'transcript_path');
  expect(transcriptPath).toBeDefined();
  expect(existsSync(transcriptPath as string)).toBe(true);

  const transcriptArtifact = readFileSync(transcriptPath as string, 'utf8');
  expect(transcriptArtifact).toContain(`"sessionID": "${childSessionID}"`);
}

async function waitForSessionMessage(
  sessionID: string,
  input: {
    role?: 'user' | 'assistant';
    predicate: (text: string) => boolean;
    timeoutMs: number;
  },
): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const match = (await readRawSessionMessages(sessionID))
      .filter((message) => !input.role || message.info?.role === input.role)
      .map(flattenMessageText)
      .find((text) => text.length > 0 && input.predicate(text));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const roleLabel = input.role ?? 'session';
  throw new Error(`Timed out waiting for matching ${roleLabel} message in session ${sessionID}.`);
}

describe('improved-task plugin integration', () => {
  describe('sync lifecycle', () => {
    it('proves improved_task sync delegation publishes a success report and reminder', async () => {
      const prompt =
        'Use improved_task once with mode=sync and subagent_type general. In the child session, reply with ONLY the word DONE. After the tool finishes, reply with ONLY OK.';

      const sessionID = beginSession(prompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);

        const report = await waitForSessionMessage(sessionID, {
          predicate: (candidate) =>
            candidate.includes(`${PASSPHRASE}:improved_task:sync:new`),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        const childSessionID = extractFrontMatterValue(report, 'session_id');
        expect(childSessionID).toBeDefined();
        expectSummaryReportPrompt({
          report,
          childSessionID: childSessionID as string,
          verificationPassphrase: `${PASSPHRASE}:improved_task:sync:new`,
        });

        const reminder = await waitForSessionMessage(sessionID, {
          predicate: (candidate) => candidate.includes('<system-reminder>'),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        expectReminderPrompt(reminder);
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);

    it('proves the shadow task tool publishes the same report contract', async () => {
      const prompt =
        'Use task once with mode=sync and subagent_type general. In the child session, reply with ONLY the word DONE. After the tool finishes, reply with ONLY OK.';

      const sessionID = beginSession(prompt, TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);

        const report = await waitForSessionMessage(sessionID, {
          predicate: (candidate) => candidate.includes(`${PASSPHRASE}:task:sync:new`),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        const childSessionID = extractFrontMatterValue(report, 'session_id');
        expect(childSessionID).toBeDefined();
        expectSummaryReportPrompt({
          report,
          childSessionID: childSessionID as string,
          verificationPassphrase: `${PASSPHRASE}:task:sync:new`,
        });
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);

    it('falls back to a new child session when session_id does not exist', async () => {
      const bogusSessionID = 'ses_does_not_exist_for_improved_task_proof';
      const prompt =
        `Use improved_task once with mode=sync, session_id=${bogusSessionID}, and subagent_type general. ` +
        'In the child session, reply with ONLY the word DONE. After the tool finishes, reply with ONLY OK.';

      const sessionID = beginSession(prompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);

        const report = await waitForSessionMessage(sessionID, {
          predicate: (candidate) =>
            candidate.includes(`${PASSPHRASE}:improved_task:sync:new`),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        const childSessionID = extractFrontMatterValue(report, 'session_id');
        expect(childSessionID).toBeDefined();
        expect(childSessionID).not.toBe(bogusSessionID);
        expect(report).not.toContain(bogusSessionID);
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });

  describe('async lifecycle', () => {
    it('proves async dispatch returns a running notice and later publishes the callback report', async () => {
      const prompt =
        'Use improved_task once with mode=async and subagent_type general. In the child session, reply with ONLY the word DONE. After improved_task returns, reply with ONLY ACK.';

      const sessionID = beginSession(prompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        const initialReply = await waitForSessionMessage(sessionID, {
          role: 'assistant',
          predicate: (candidate) => candidate.includes('ACK'),
          timeoutMs: ASSISTANT_REPLY_TIMEOUT_MS,
        });
        expect(initialReply).toContain('ACK');

        const report = await waitForSessionMessage(sessionID, {
          predicate: (candidate) =>
            candidate.includes(`${PASSPHRASE}:improved_task:async:new`),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        const childSessionID = extractFrontMatterValue(report, 'session_id');
        expect(childSessionID).toBeDefined();
        expectSummaryReportPrompt({
          report,
          childSessionID: childSessionID as string,
          verificationPassphrase: `${PASSPHRASE}:improved_task:async:new`,
        });

        const reminder = await waitForSessionMessage(sessionID, {
          predicate: (candidate) => candidate.includes('<system-reminder>'),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        expectReminderPrompt(reminder);
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });

  describe('resume', () => {
    it('proves the parent session can continue after sync delegation publishes its report', async () => {
      const firstPrompt =
        'Use improved_task once with mode=sync and subagent_type general. In the child session, reply with ONLY DONE. Reply with ONLY OK when the tool finishes.';

      const sessionID = beginSession(firstPrompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);
        const firstReport = await waitForSessionMessage(sessionID, {
          predicate: (candidate) =>
            candidate.includes(`${PASSPHRASE}:improved_task:sync:new`),
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        expect(firstReport).toContain(`${PASSPHRASE}:improved_task:sync:new`);

        runOcm(['chat', sessionID, 'Reply with EXACTLY RESUMED.']);
        waitIdle(sessionID);

        const resumeText = await waitForSessionMessage(sessionID, {
          role: 'assistant',
          predicate: (candidate) => candidate.includes('RESUMED'),
          timeoutMs: ASSISTANT_REPLY_TIMEOUT_MS,
        });
        expect(resumeText).toContain('RESUMED');
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });
});
