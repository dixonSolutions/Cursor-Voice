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
import { childLogger } from '../../log.js';
import { resolveProjectOrThrow } from './project.js';
import { looksLikeReadOnlyQuestion, looksLikeMutationRequest } from './questionDetect.js';
import { setLastAsk, truncateForVoice } from '../../state/lastAsk.js';

const log = childLogger('tool:execute');

// ── cursor_submit ─────────────────────────────────────────────────────────

export interface SubmitArgs {
  prompt: string;
  project?: string;
  mode?: 'agent' | 'plan';
}

export interface SubmitResult {
  job_id?: string;
  status?: 'running';
  project: string;
  model?: string;
  message: string;
  /** Present when a question was misrouted to submit — answered via cursor_ask instead. */
  routed?: 'ask';
  answer?: string;
  has_more?: boolean;
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

  if (looksLikeReadOnlyQuestion(args.prompt)) {
    log.info(
      { project: project.name, prompt: args.prompt.slice(0, 100) },
      'cursor_submit redirected to cursor_ask (read-only question)',
    );
    const ask = await handleCursorAsk(
      { question: args.prompt, project: args.project },
      sessionKey,
      activeProject,
    );
    return {
      routed: 'ask',
      answer: ask.answer,
      has_more: ask.has_more,
      project: ask.project,
      message:
        'Read-only question — answered via cursor_ask. Read the answer field to the user now.',
    };
  }

  const mode = args.mode ?? 'agent';
  const result = await submitJob(project, sessionKey, args.prompt, mode);

  return {
    job_id: result.jobId,
    status: 'running',
    project: result.project,
    model: result.model,
    message: `Job started (${result.jobId}). The user can ask what's happening anytime — use cursor_status without job_id.`,
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
  has_more: boolean;
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
  const project = resolveProjectOrThrow(args.project, activeProject);

  if (looksLikeMutationRequest(args.question)) {
    throw new Error(
      'This request changes the repo (commit, PR, merge, implement, etc.) — use cursor_submit, not cursor_ask.',
    );
  }

  const fullAnswer = await askQuestion(project, sessionKey, args.question);

  setLastAsk(sessionKey, {
    question: args.question,
    answer: fullAnswer,
    project: project.name,
  });

  const voiceAnswer = truncateForVoice(fullAnswer);
  return {
    answer: voiceAnswer,
    project: project.name,
    has_more: voiceAnswer.length < fullAnswer.length,
  };
}
