/**
 * Approval Registry — stores pending agent-to-user requests as deferred promises.
 *
 * When Cursor's agent calls `request_user_input` or `submit_plan_for_approval`, the
 * MCP tool handler registers a deferred promise here. The tool call blocks (long-poll)
 * until the PWA user answers and POSTs back via the control WebSocket
 * `approval_response` message, which resolves the promise and unblocks the tool call.
 *
 * Two request types share the same registry:
 *   - user_input  : free-text / yes-no / choice questions
 *   - plan        : multi-step plan accept / reject / modify
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../../log.js';

const log = childLogger('approval-registry');

// ── Types ─────────────────────────────────────────────────────────────────

export type InputType = 'yesno' | 'choice' | 'freetext';

export interface UserInputRequest {
  kind: 'user_input';
  request_id: string;
  question: string;
  input_type: InputType;
  options?: string[];
}

export interface PlanApprovalRequest {
  kind: 'plan_approval';
  request_id: string;
  title: string;
  steps: string[];
  estimated_impact?: string;
}

export type ApprovalRequest = UserInputRequest | PlanApprovalRequest;

export interface UserInputResponse {
  kind: 'user_input';
  answer: string;
}

export interface PlanApprovalResponse {
  kind: 'plan_approval';
  decision: 'approved' | 'rejected' | 'modified';
  notes?: string;
}

export type ApprovalResponse = UserInputResponse | PlanApprovalResponse;

interface Deferred {
  resolve: (value: ApprovalResponse) => void;
  reject: (reason: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// ── Registry ──────────────────────────────────────────────────────────────

const pending = new Map<string, Deferred>();

/**
 * Register a new pending request. Returns the `request_id` and a Promise that
 * resolves when the user responds, or rejects on timeout.
 */
export function registerRequest(
  requestFactory: (request_id: string) => ApprovalRequest,
  timeoutMs: number,
): { request_id: string; promise: Promise<ApprovalResponse> } {
  const request_id = randomUUID();

  const promise = new Promise<ApprovalResponse>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (pending.has(request_id)) {
        pending.delete(request_id);
        log.warn({ request_id }, 'approval request timed out');
        reject(new Error(`User did not respond within ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    pending.set(request_id, { resolve, reject, timeoutHandle });
  });

  // Build the request payload (needs the id)
  requestFactory(request_id);

  return { request_id, promise };
}

/**
 * Resolve a pending request with the user's response.
 * Called when the PWA sends an `approval_response` WS message.
 * Returns true if the request_id was found and resolved.
 */
export function resolveRequest(request_id: string, response: ApprovalResponse): boolean {
  const deferred = pending.get(request_id);
  if (!deferred) {
    log.warn({ request_id }, 'resolveRequest: no pending request for id');
    return false;
  }
  clearTimeout(deferred.timeoutHandle);
  pending.delete(request_id);
  deferred.resolve(response);
  log.info({ request_id, kind: response.kind }, 'approval request resolved');
  return true;
}

/** Cancel a pending request (e.g. on WS disconnect). */
export function cancelRequest(request_id: string, reason = 'Cancelled'): boolean {
  const deferred = pending.get(request_id);
  if (!deferred) return false;
  clearTimeout(deferred.timeoutHandle);
  pending.delete(request_id);
  deferred.reject(new Error(reason));
  return true;
}

/** Cancel all pending requests (e.g. on server shutdown). */
export function cancelAllRequests(reason = 'Bridge shutting down'): void {
  for (const [id] of pending) {
    cancelRequest(id, reason);
  }
}

export function pendingCount(): number {
  return pending.size;
}
