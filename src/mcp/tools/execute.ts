/**
 * Execute tools — cursor_submit, cursor_ask
 *
 * cursor_submit: async job submission (returns job_id immediately).
 * cursor_ask:    synchronous read-only Q&A (hard-coded --mode ask).
 *
 * Both resolve the project from the registry. The model controls the
 * prompt/question text only — workspace path comes from the registry.
 */

import { submitJob, askQuestion } from '../../executor/jobManager.js';
import { resolveProjectOrThrow } from './project.js';

// ── cursor_submit ─────────────────────────────────────────────────────────

export interface SubmitArgs {
  prompt: string;
  project?: string;
  mode?: 'agent' | 'plan';
}

export interface SubmitResult {
  job_id: string;
  status: 'running';
  project: string;
  model: string;
  message: string;
}

/**
 * Submit work to cursor-agent (async).
 * Returns immediately with a job_id. Track progress with cursor_status.
 */
export async function handleCursorSubmit(
  args: SubmitArgs,
  sessionKey: string,
  activeProject: string | null,
): Promise<SubmitResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);
  const mode = args.mode ?? 'agent';

  const result = await submitJob(project, sessionKey, args.prompt, mode);

  return {
    job_id: result.jobId,
    status: 'running',
    project: result.project,
    model: result.model,
    message: `Job started on ${result.project}. Use cursor_status("${result.jobId}") to check progress.`,
  };
}

// ── cursor_ask ────────────────────────────────────────────────────────────

export interface AskArgs {
  question: string;
  project?: string;
}

export interface AskResult {
  answer: string;
  project: string;
}

/**
 * Read-only repo Q&A. Always runs in --mode ask (cannot write or mutate).
 * One-shot — does not resume or persist a session.
 * This is the voice model's ONLY route to repo facts.
 */
export async function handleCursorAsk(
  args: AskArgs,
  sessionKey: string,
  activeProject: string | null,
): Promise<AskResult> {
  const project = resolveProjectOrThrow(args.question ? args.project : args.project, activeProject);
  const answer = await askQuestion(project, sessionKey, args.question);

  return { answer, project: project.name };
}
