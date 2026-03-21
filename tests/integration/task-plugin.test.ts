/**
 * Integration tests for improved-task plugin.
 *
 * Architecture: Uses centralized .testrc environment.
 * All setup handled by direnv exec - no custom runtime creation.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Environment - sourced from .testrc via plugin .envrc
// ---------------------------------------------------------------------------

const BASE_URL = process.env.OPENCODE_BASE_URL;
if (!BASE_URL) throw new Error('OPENCODE_BASE_URL must be set (run via `just test`)');

const PASSPHRASE = process.env.IMPROVED_TASK_TEST_PASSPHRASE?.trim();
if (!PASSPHRASE) throw new Error('IMPROVED_TASK_TEST_PASSPHRASE must be set (sourced from plugin .envrc)');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANAGER_PACKAGE = 'git+https://github.com/dzackgarza/opencode-manager.git';
const MAX_BUFFER = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 240_000;

const IMPROVED_TASK_PROOF_AGENT = 'improved-task-proof';
const TASK_PROOF_AGENT = 'task-proof';

// Plugin root — used as the cwd reference (not process.cwd() which depends on invocation dir)
const PLUGIN_ROOT = new URL('../..', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    'uvx',
    ['--from', MANAGER_PACKAGE, 'ocm', ...args],
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL },
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

type TranscriptStep = {
  type: string;
  tool?: string;
  status?: string;
  outputText?: string;
  contentText?: string;
};

function readTranscriptSteps(sessionID: string): TranscriptStep[] {
  const { stdout } = runOcm(['transcript', sessionID, '--json']);
  const data = JSON.parse(stdout) as {
    turns: Array<{
      assistantMessages: Array<{ steps: Array<TranscriptStep | null> }>;
    }>;
  };
  return data.turns.flatMap((turn) =>
    turn.assistantMessages.flatMap((msg) =>
      (msg.steps ?? []).filter((s): s is TranscriptStep => s !== null),
    ),
  );
}

function readFinalAssistantText(sessionID: string): string {
  const { stdout } = runOcm(['transcript', sessionID, '--json']);
  const data = JSON.parse(stdout) as {
    turns: Array<{
      assistantMessages: Array<{
        steps: Array<{ type: string; contentText?: string } | null>;
      }>;
    }>;
  };
  const parts = data.turns.flatMap((turn) =>
    turn.assistantMessages.flatMap((msg) =>
      (msg.steps ?? [])
        .filter((s): s is { type: string; contentText: string } =>
          s !== null && s.type === 'text' && typeof s.contentText === 'string',
        )
        .map((s) => s.contentText),
    ),
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('improved-task plugin integration', () => {
  describe('tool visibility', () => {
    it('proves improved_task tool description embeds the verification passphrase', () => {
      const prompt =
        'Reply with EXACTLY the verification passphrase from the improved_task tool description. Do not call improved_task. Reply with ONLY the passphrase, nothing else.';

      const sessionID = beginSession(prompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);
        const text = readFinalAssistantText(sessionID);
        expect(text).toContain(PASSPHRASE);
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });

  describe('sync lifecycle', () => {
    it('proves improved_task sync delegation completes and returns OK', () => {
      const prompt =
        'Use improved_task once with mode=sync and subagent_type general. In the child session, reply with ONLY the word DONE. After the tool finishes, reply with ONLY OK.';

      const sessionID = beginSession(prompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);
        const steps = readTranscriptSteps(sessionID);
        const rawTranscript = JSON.stringify(steps, null, 2);

        const taskStep = steps.find(
          (s) => s.type === 'tool' && s.tool === 'improved_task' && s.status === 'completed',
        );
        expect(taskStep, `improved_task step missing. Steps:\n${rawTranscript}`).toBeDefined();

        const text = readFinalAssistantText(sessionID);
        expect(text).toContain('OK');
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });

  describe('resume', () => {
    it('proves session can be resumed after sync delegation', () => {
      const firstPrompt =
        'Use improved_task once with mode=sync and subagent_type general. In the child session, reply with ONLY DONE. Reply with ONLY OK when the tool finishes.';

      const sessionID = beginSession(firstPrompt, IMPROVED_TASK_PROOF_AGENT);
      try {
        waitIdle(sessionID);
        const firstText = readFinalAssistantText(sessionID);
        expect(firstText).toContain('OK');

        // Resume with a follow-up chat message
        runOcm(['chat', sessionID, 'Reply with EXACTLY RESUMED.']);
        waitIdle(sessionID);

        const resumeText = readFinalAssistantText(sessionID);
        expect(resumeText).toContain('RESUMED');
      } finally {
        try { runOcm(['delete', sessionID]); } catch { /* best-effort */ }
      }
    }, SESSION_TIMEOUT_MS);
  });
});
