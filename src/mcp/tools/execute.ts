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
import {
  looksLikeReadOnlyQuestion,
  looksLikeMutationRequest,
  isMetaVoiceBridgeQuestion,
  normalizeAskQuestion,
  isReadOnlyResearchIntent,
} from './questionDetect.js';
import { isAgentBusy, getActiveAgentRun } from '../../executor/agentSingleton.js';
import { getLastAsk, setLastAsk, truncateForVoice } from '../../state/lastAsk.js';

const log = childLogger('tool:execute');

// ── cursor_submit ─────────────────────────────────────────────────────────

export interface SubmitArgs {
  prompt: string;
  project?: string;
  mode?: 'agent' | 'plan';
  browser?: boolean;
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

  if (looksLikeReadOnlyQuestion(args.prompt) || isReadOnlyResearchIntent(args.prompt)) {
    log.info(
      { project: project.name, prompt: args.prompt.slice(0, 100) },
      'cursor_submit redirected to cursor_ask (read-only question)',
    );
    const ask = await handleCursorAsk(
      { question: normalizeAskQuestion(args.prompt), project: args.project },
      sessionKey,
      activeProject,
    );
    return {
      routed: 'ask',
      answer: ask.answer,
      has_more: ask.has_more,
      project: ask.project,
      message:
        'Read-only question answered. Summarize the answer field for the user in a few sentences.',
    };
  }

  const mode = args.mode ?? 'agent';
  const result = await submitJob(project, sessionKey, args.prompt, mode, undefined, args.browser);

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
  message?: string;
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
  const question = normalizeAskQuestion(args.question.trim());
  const qKey = question.toLowerCase();

  if (looksLikeMutationRequest(question)) {
    throw new Error(
      'This request changes the repo (commit, PR, merge, implement, etc.) — use cursor_submit, not cursor_ask.',
    );
  }

  if (isMetaVoiceBridgeQuestion(question)) {
    const last = getLastAsk(sessionKey);
    if (last) {
      const voiceAnswer = truncateForVoice(last.answer);
      return {
        answer: voiceAnswer,
        project: last.project,
        has_more: voiceAnswer.length < last.answer.length,
        message:
          'The user likely heard TTS echo — do not ask Cursor about setting up agents. ' +
          'Summarize the previous answer about implementation steps instead.',
      };
    }
    throw new Error(
      'That question is about the voice bridge, not this codebase. Ask about the project implementation instead.',
    );
  }

  if (isAgentBusy()) {
    const active = getActiveAgentRun();
    if (active?.kind === 'ask') {
      throw new Error(
        'Cursor is still researching your question. Use cursor_status for live progress — do not call cursor_ask again yet.',
      );
    }
  }

  const last = getLastAsk(sessionKey);
  if (last && last.question.trim().toLowerCase() === qKey) {
    const ageMs = Date.now() - new Date(last.completedAt).getTime();
    if (ageMs < 5 * 60_000) {
      log.info({ sessionKey, question: question.slice(0, 80) }, 'cursor_ask cache hit');
      const voiceAnswer = truncateForVoice(last.answer);
      return {
        answer: voiceAnswer,
        project: last.project,
        has_more: voiceAnswer.length < last.answer.length,
        message:
          'This question was just answered — read the answer field aloud for the user in 2–4 sentences.',
      };
    }
  }

  const fullAnswer = await askQuestion(project, sessionKey, question);

  setLastAsk(sessionKey, {
    question,
    answer: fullAnswer,
    project: project.name,
  });

  const voiceAnswer = truncateForVoice(fullAnswer);
  return {
    answer: voiceAnswer,
    project: project.name,
    has_more: voiceAnswer.length < fullAnswer.length,
    message:
      'Cursor finished. You MUST speak now: summarize the answer field in 3–5 short sentences for the user. ' +
      'Do not stay silent. If they later ask to summarize or repeat, use cursor_recall_answer.',
  };
}
