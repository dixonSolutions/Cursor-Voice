/**
 * Standing instructions prepended to cursor-agent prompts.
 * Keep minimal — Cursor handles the work; we only pass the user's words through.
 */

/** Submit jobs — block budget-burning Task/subagent spawns (watcher enforces too). */
export const AGENT_GUARDRAILS = `Do not use the Task tool or spawn subagents. Work in this session only.

USER REQUEST:`;

/** Ask — pass the question through; no extra rules for Cursor. */
export const ASK_GUARDRAILS = `QUESTION:`;

export function buildAgentPrompt(userPrompt: string): string {
  return `${AGENT_GUARDRAILS}\n\n${userPrompt.trim()}`;
}

export function buildAskPrompt(question: string): string {
  return `${ASK_GUARDRAILS}\n\n${question.trim()}`;
}
