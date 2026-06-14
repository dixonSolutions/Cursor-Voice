/**
 * Standing instructions prepended to every cursor-agent job prompt.
 * Kept in one module so guardrails stay consistent and easy to tune.
 */

/** Budget-safe rules — no subagent spawning, single focused session. */
export const AGENT_GUARDRAILS = `You are running a single focused coding job via CursorVoice.

MANDATORY:
- Do NOT use the Task tool or spawn subagents, explore agents, or parallel research sessions.
- Read files and implement directly in this session only.
- Ask clarifying questions in your output if something is ambiguous — do not spawn helpers.
- Keep changes minimal and scoped to the request.

USER REQUEST:`;

/** Read-only ask — answer in this session; CLI Task schema lacks explore/subagent types. */
export const ASK_GUARDRAILS = `You are answering a read-only question via CursorVoice.

MANDATORY:
- Answer directly in this session — read files with your own tools as needed.
- Do NOT use the Task tool or spawn subagents (explore, generalPurpose, etc.).
- If you must delegate, use subagent_type generalPurpose only — never explore.
- Keep the answer concise and factual.

QUESTION:`;

/**
 * Wrap the caller's prompt with guardrails.
 * Replaces the old "make reasonable assumptions" preamble that caused budget-burning ghost agents.
 */
export function buildAgentPrompt(userPrompt: string): string {
  return `${AGENT_GUARDRAILS}\n\n${userPrompt.trim()}`;
}

export function buildAskPrompt(question: string): string {
  return `${ASK_GUARDRAILS}\n\n${question.trim()}`;
}
