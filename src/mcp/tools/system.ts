/**
 * System tools — cursor_agent_info, cursor_agent_status
 *
 * Backed by cursor-agent about --format json and status --format json.
 * Used by the health endpoint and by the voice model when asked "what version?"
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { childLogger } from '../../log.js';

const execFileAsync = promisify(execFile);
const log = childLogger('tool:system');

// ── cursor_agent_info ─────────────────────────────────────────────────────

export interface AgentInfoResult {
  cliVersion: string;
  model: string;
  subscriptionTier: string | null;
  osPlatform: string;
  osArch: string;
  userEmail: string | null;
}

/**
 * Wraps `cursor-agent about --format json`.
 * Live output shape (June 2026):
 * { cliVersion, model, subscriptionTier, osPlatform, osArch, userEmail, terminalProgram, shell, lastRequestId }
 */
export async function handleCursorAgentInfo(): Promise<AgentInfoResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('cursor-agent', ['about', '--format', 'json'], {
      timeout: 10_000,
    }));
  } catch (err) {
    throw new Error(`cursor-agent about failed: ${String(err)}`);
  }

  const raw = stripAnsi(stdout).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    log.warn({ raw }, 'failed to parse cursor-agent about JSON');
    throw new Error('cursor-agent about returned non-JSON output');
  }

  return {
    cliVersion: String(parsed['cliVersion'] ?? 'unknown'),
    model: String(parsed['model'] ?? 'unknown'),
    subscriptionTier: typeof parsed['subscriptionTier'] === 'string' ? parsed['subscriptionTier'] : null,
    osPlatform: String(parsed['osPlatform'] ?? 'unknown'),
    osArch: String(parsed['osArch'] ?? 'unknown'),
    userEmail: typeof parsed['userEmail'] === 'string' ? parsed['userEmail'] : null,
  };
}

// ── cursor_agent_status ───────────────────────────────────────────────────

export interface AgentStatusResult {
  authenticated: boolean;
  email: string | null;
  firstName: string | null;
}

/**
 * Wraps `cursor-agent status --format json`.
 * Live output shape (June 2026):
 * { status, isAuthenticated, hasAccessToken, hasRefreshToken, userInfo: { email, userId, firstName, lastName, createdAt } }
 */
export async function handleCursorAgentStatus(): Promise<AgentStatusResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('cursor-agent', ['status', '--format', 'json'], {
      timeout: 10_000,
    }));
  } catch (err) {
    throw new Error(`cursor-agent status failed: ${String(err)}`);
  }

  const raw = stripAnsi(stdout).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('cursor-agent status returned non-JSON output');
  }

  const userInfo = (parsed['userInfo'] ?? {}) as Record<string, unknown>;

  return {
    authenticated: parsed['isAuthenticated'] === true,
    email: typeof userInfo['email'] === 'string' ? userInfo['email'] : null,
    firstName: typeof userInfo['firstName'] === 'string' ? userInfo['firstName'] : null,
  };
}
