/**
 * Session tools — cursor_new_session, cursor_session_info
 *
 * cursor_new_session: clear the project's resume_id so next submit starts fresh.
 * cursor_session_info: read persisted session state without running the CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import {
  clearProjectResumeId,
  setProjectResumeId,
  getProjectByName,
} from '../../state/registry.js';
import { getLatestJobForProject } from '../../state/jobs.js';
import { resolveProjectOrThrow } from './project.js';
import { childLogger } from '../../log.js';
import { buildCursorAgentEnv } from '../../executor/cursorAgent.js';

const execFileAsync = promisify(execFile);
const log = childLogger('tool:session');

// ── cursor_new_session ────────────────────────────────────────────────────

export interface NewSessionArgs {
  project?: string;
}

export interface NewSessionResult {
  project: string;
  session_id: string | null;
  message: string;
}

/**
 * Clear the project's resume_id so the next cursor_submit starts a fresh
 * conversation thread. Optionally pre-creates a session ID via create-chat.
 */
export async function handleNewSession(
  args: NewSessionArgs,
  activeProject: string | null,
): Promise<NewSessionResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);

  // Optionally call create-chat to get a fresh ID up front.
  let newSessionId: string | null = null;
  try {
    const { stdout } = await execFileAsync('cursor-agent', ['create-chat'], {
      timeout: 10_000,
      env: buildCursorAgentEnv(),
    });
    newSessionId = stripAnsi(stdout).trim() || null;
    if (newSessionId) {
      setProjectResumeId(project.name, newSessionId);
      log.info({ project: project.name, sessionId: newSessionId }, 'new session pre-created');
    }
  } catch (err) {
    // create-chat failure is non-fatal — just clear the old id
    log.warn({ err }, 'create-chat failed, clearing resume_id only');
    clearProjectResumeId(project.name);
  }

  return {
    project: project.name,
    session_id: newSessionId,
    message: newSessionId
      ? `New session started on ${project.name} (id: ${newSessionId}).`
      : `Session cleared on ${project.name}. Next submit will start a fresh thread.`,
  };
}

// ── cursor_session_info ───────────────────────────────────────────────────

export interface SessionInfoArgs {
  project?: string;
}

export interface SessionInfoResult {
  project: string;
  resume_id: string | null;
  last_job_id: string | null;
  last_run_at: string | null;
}

/**
 * Read the persisted session state for a project without running the CLI.
 * Useful for the voice model to narrate "you were last working on X N minutes ago".
 */
export function handleSessionInfo(
  args: SessionInfoArgs,
  activeProject: string | null,
): SessionInfoResult {
  const project = resolveProjectOrThrow(args.project, activeProject);
  const row = getProjectByName(project.name);
  const lastJob = getLatestJobForProject(project.name);

  return {
    project: project.name,
    resume_id: row?.resumeId ?? null,
    last_job_id: lastJob?.id ?? null,
    last_run_at: lastJob?.startedAt ?? null,
  };
}
