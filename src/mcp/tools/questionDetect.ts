/**
 * Detect read-only questions misrouted to cursor_submit.
 * Server-side guard — questions must use cursor_ask (no code changes).
 */

const MUTATION_VERBS =
  /\b(implement|build|create|fix|add|change|refactor|write|update|delete|remove|commit|deploy|install|migrate|rename|merge)\b/i;

const QUESTION_PATTERNS = [
  /\b(what|which|how|why|when|where|who)\b/i,
  /\bnext\b.*\b(steps?|milestones?|phase|priority|tasks?)\b/i,
  /\b(implementation|roadmap|plan|status|progress|done|remaining|left)\b/i,
  /\b(tell me|describe|explain|list|summarize|overview)\b/i,
  /\bget the next\b/i,
  /\basking about\b/i,
];

/** cursor-agent execution modes — NOT valid cursor_set_model IDs. */
export const EXECUTION_MODES = new Set(['agent', 'plan', 'ask']);

export function looksLikeReadOnlyQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (looksLikeMutationRequest(trimmed)) return false;
  return QUESTION_PATTERNS.some((p) => p.test(trimmed));
}

/** Requests that write git state or files — must use cursor_submit. */
export function looksLikeMutationRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (MUTATION_VERBS.test(trimmed)) return true;
  return /\bpull request\b/i.test(trimmed);
}

/** True when model_id is actually a cursor_submit / cursor_ask execution mode. */
export function parseMisroutedExecutionMode(modelId: string): string | null {
  const normalized = modelId.toLowerCase().replace(/\s+mode$/, '').trim();
  return EXECUTION_MODES.has(normalized) ? normalized : null;
}
