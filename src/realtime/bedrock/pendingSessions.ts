/**
 * Pending Bedrock voice sessions — created at token mint, consumed at /ws/voice auth.
 */

import type { SessionConfig } from '../provider.js';

export interface PendingBedrockSession {
  model: string;
  region: string;
  config: SessionConfig;
  expiresAt: number;
}

const pending = new Map<string, PendingBedrockSession>();

const TTL_MS = 8 * 60 * 1000;

export function registerPendingBedrockSession(
  sessionId: string,
  model: string,
  region: string,
  config: SessionConfig,
): void {
  purgeExpired();
  pending.set(sessionId, {
    model,
    region,
    config,
    expiresAt: Date.now() + TTL_MS,
  });
}

export function consumePendingBedrockSession(sessionId: string): PendingBedrockSession | null {
  purgeExpired();
  const row = pending.get(sessionId);
  if (!row) return null;
  pending.delete(sessionId);
  return row;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, row] of pending) {
    if (row.expiresAt <= now) pending.delete(id);
  }
}
