/**
 * cursor-agent executor — spawn, parse, kill.
 *
 * This module is the ONLY place cursor-agent CLI knowledge lives.
 * When the CLI changes, this is the one-file fix.
 *
 * Key design rules from docs/03-security.md and docs/05:
 *   - `shell: false` always — no shell interpolation.
 *   - `--workspace` comes from the registry, never from the caller.
 *   - The prompt string is the ONLY caller-controlled argv element.
 *   - `strip-ansi` run defensively before JSON.parse.
 *   - Session IDs captured from structured output, not TTY scraping.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import stripAnsi from 'strip-ansi';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import type { Project } from '../state/registry.js';
import type { SessionState } from '../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from './agentPrompt.js';
import type { StreamJsonEvent } from './watcher.js';

const log = childLogger('cursor-agent');

/** Env for cursor-agent subprocesses — HOME is required by the CLI wrapper (set -u). */
export function buildCursorAgentEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME ?? homedir(),
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  };
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  project: Project;
  session: SessionState;
  prompt: string;
  mode?: 'agent' | 'plan' | 'ask' | 'debug';
  /** If true, use --output-format json (one-shot, for cursor_ask). */
  oneShot?: boolean;
  /**
   * If set, run in an isolated git worktree at ~/.cursor/worktrees/<worktree>.
   * Enables parallel agents on the same project without working-tree conflicts.
   * CLI flag: -w <name>
   */
  worktree?: string;
  /** Append browser snapshot instructions to the worker prompt. */
  browser?: boolean;
}

export interface AgentHandle {
  pid: number;
  /** Resolves when the process exits (exit code, captured session_id, and final summary). */
  result: Promise<AgentResult>;
  /** Kill the process (SIGTERM → SIGKILL after 5 s). */
  kill(): void;
  /** Subscribe to parsed stream-json events (called for each line). */
  onEvent: (cb: (event: StreamJsonEvent) => void) => void;
}

export interface AgentResult {
  exitCode: number;
  sessionId: string | null;
  summary: string | null;
  error: string | null;
}

// ── Flag builder ──────────────────────────────────────────────────────────

/**
 * Builds the cursor-agent argument array.
 * Shell interpolation is impossible here — this is an array, not a string.
 */
export function buildArgs(opts: SpawnOptions): string[] {
  const { project, session, prompt, mode = 'agent', oneShot = false, worktree, browser } = opts;
  const { settings } = getConfig();

  const args: string[] = [
    '-p', // print / headless mode
    '--output-format',
    oneShot ? 'json' : 'stream-json',
    '--workspace',
    project.path, // ONLY from registry — never from caller
  ];

  // Worktree: isolated git worktree for parallel agents (no working-tree conflicts).
  if (worktree) {
    args.push('-w', worktree);
  }

  // Model: from session state (default 'auto' = Cursor chooses).
  if (session.activeModel && session.activeModel !== 'auto') {
    args.push('--model', session.activeModel);
  }

  // Resume session for submit jobs only — ask/worktree mode always starts fresh.
  if (project.resumeId && !oneShot && mode !== 'ask' && !worktree) {
    args.push('--resume', project.resumeId);
  }

  // Mode flags. 'debug' maps to agent mode (no CLI flag) — debug intent is prompt-steered.
  if (mode === 'plan') {
    args.push('--mode', 'plan');
  } else if (mode === 'ask') {
    args.push('--mode', 'ask');
  }
  // 'agent' and 'debug' are the default; no flag needed.

  // Pre-run flags from config (e.g. ['--force', '--trust']).
  // Applied after mode flags so they can't change mode.
  for (const flag of settings.preRunFlags) {
    args.push(flag);
  }

  // Prompt is the last — the only caller-controlled value.
  if (mode === 'ask') {
    args.push(buildAskPrompt(prompt));
  } else {
    args.push(buildAgentPrompt(prompt, { browser }));
  }

  return args;
}

// ── Spawn ─────────────────────────────────────────────────────────────────

/**
 * Spawn a cursor-agent process and return a handle for lifecycle management.
 *
 * stdout: NDJSON events (readline), forwarded to event subscribers.
 * stderr: buffered for error capture.
 */
export function spawnAgent(opts: SpawnOptions): AgentHandle {
  const args = buildArgs(opts);

  log.info(
    {
      project: opts.project.name,
      mode: opts.mode ?? 'agent',
      resume: opts.project.resumeId ?? 'none',
      model: opts.session.activeModel,
    },
    'spawning cursor-agent',
  );
  log.debug({ args }, 'cursor-agent args');

  const child = spawn('cursor-agent', args, {
    cwd: opts.project.path,
    shell: false, // SECURITY: never true
    env: buildCursorAgentEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid;
  if (!pid) throw new Error('cursor-agent failed to spawn (no pid)');

  const eventListeners: Array<(event: StreamJsonEvent) => void> = [];

  // ── stdout readline parser ─────────────────────────────────────────────

  let capturedSessionId: string | null = null;
  let capturedSummary: string | null = null;

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    // Defensive: strip ANSI escape codes before parsing.
    const clean = stripAnsi(raw).trim();
    if (!clean) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      log.debug({ raw: clean }, 'non-JSON line from cursor-agent (ignored)');
      return;
    }

    // Capture session_id wherever it appears (system:init or result).
    if (typeof event['session_id'] === 'string') {
      capturedSessionId = event['session_id'];
    }

    // Capture summary from result event (field name varies by CLI version).
    if (event['type'] === 'result') {
      if (typeof event['result'] === 'string' && event['result'].trim()) {
        capturedSummary = event['result'];
      } else {
        const msg = event['message'];
        if (typeof msg === 'string') {
          capturedSummary = msg;
        } else if (
          typeof msg === 'object' &&
          msg !== null &&
          'content' in msg &&
          Array.isArray((msg as { content: unknown[] }).content)
        ) {
          const textPart = (msg as { content: Array<{ text?: string }> }).content.find(
            (c) => typeof c.text === 'string',
          );
          if (textPart?.text) capturedSummary = textPart.text;
        }
      }
    }

    // Fallback: last assistant text turn (stream-json ask/agent).
    if (event['type'] === 'assistant') {
      const msg = event['message'];
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'content' in msg &&
        Array.isArray((msg as { content: unknown[] }).content)
      ) {
        const textPart = (msg as { content: Array<{ text?: string }> }).content.find(
          (c) => typeof c.text === 'string',
        );
        if (textPart?.text?.trim()) capturedSummary = textPart.text;
      }
    }

    // Forward the typed event to all subscribers.
    const typed = event as StreamJsonEvent;
    for (const cb of eventListeners) {
      cb(typed);
    }
  });

  // ── stderr capture ─────────────────────────────────────────────────────

  const stderrChunks: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // ── Process lifecycle ──────────────────────────────────────────────────

  let killTimer: ReturnType<typeof setTimeout> | null = null;

  function kill(): void {
    log.info({ pid }, 'sending SIGTERM to cursor-agent');
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      log.warn({ pid }, 'cursor-agent did not exit after SIGTERM — sending SIGKILL');
      child.kill('SIGKILL');
    }, 5000);
  }

  const result: Promise<AgentResult> = new Promise((resolve) => {
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      rl.close();

      const exitCode = code ?? -1;
      const stderr = stripAnsi(Buffer.concat(stderrChunks).toString('utf-8')).trim();

      if (exitCode !== 0) {
        log.warn({ pid, exitCode, stderr: stderr.slice(0, 500) }, 'cursor-agent exited with error');
      } else {
        log.info({ pid, sessionId: capturedSessionId }, 'cursor-agent completed');
      }

      resolve({
        exitCode,
        sessionId: capturedSessionId,
        summary: capturedSummary,
        error: exitCode !== 0 ? (stderr || `Process exited with code ${exitCode}`) : null,
      });
    });
  });

  return {
    pid,
    result,
    kill,
    onEvent: (cb) => eventListeners.push(cb),
  };
}

// ── Model list parsing ────────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  displayName: string;
}

/**
 * Parse the plain-text output of `cursor-agent models`.
 * Format: `<id> - <display name>` (one per line).
 * Strips the header "Available models" and the tip line.
 */
export function parseModelsOutput(raw: string): ModelEntry[] {
  return raw
    .split('\n')
    .map((line) => stripAnsi(line).trim())
    .filter(
      (line) =>
        line.includes(' - ') &&
        !line.startsWith('Tip:') &&
        !line.startsWith('Available models'),
    )
    .map((line) => {
      const dashIdx = line.indexOf(' - ');
      return {
        id: line.slice(0, dashIdx).trim(),
        displayName: line.slice(dashIdx + 3).trim(),
      };
    })
    .filter((m) => m.id.length > 0 && m.displayName.length > 0);
}

// ── About / status JSON parsing ───────────────────────────────────────────

export interface AgentAbout {
  cliVersion: string;
  model: string;
  osPlatform: string;
  osArch: string;
}

export function parseAboutJson(raw: string): AgentAbout | null {
  try {
    const parsed = JSON.parse(stripAnsi(raw).trim()) as Partial<AgentAbout>;
    if (!parsed.cliVersion) return null;
    return {
      cliVersion: parsed.cliVersion ?? '',
      model: parsed.model ?? '',
      osPlatform: parsed.osPlatform ?? '',
      osArch: parsed.osArch ?? '',
    };
  } catch {
    return null;
  }
}
