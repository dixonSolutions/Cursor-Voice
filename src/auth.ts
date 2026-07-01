/**
 * Application-layer authentication.
 *
 * Security rule: every HTTP request and every WebSocket frame that triggers an
 * action MUST pass through these functions. Tailscale is network-layer only;
 * the app token is the API-level gate.
 *
 * Implementation details:
 *   - Constant-time comparison (crypto.timingSafeEqual) prevents timing attacks.
 *   - Length mismatch is handled safely — we still run a dummy comparison so the
 *     code path always takes the same amount of time.
 *   - 401 on HTTP; socket close on WS.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from './config.js';
import { childLogger } from './log.js';

const log = childLogger('auth');

// ── Token comparison ──────────────────────────────────────────────────────────

/**
 * Constant-time string equality. Safe against timing attacks.
 * Returns true only if `a` and `b` are byte-for-byte identical.
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');

  if (ba.length !== bb.length) {
    // Perform a dummy comparison so branch timing is not length-dependent.
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }

  return timingSafeEqual(ba, bb);
}

/** Extract a Bearer token from an Authorization header. Returns null if absent/malformed. */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

/**
 * Verify a candidate token against the configured APP_TOKEN.
 * `null` / `undefined` / empty string all return false.
 */
export function verifyToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const { env } = getConfig();
  return safeEqual(candidate, env.APP_TOKEN);
}

// ── Fastify middleware ────────────────────────────────────────────────────────

/**
 * Fastify preHandler hook for HTTP routes.
 * Reads `Authorization: Bearer <token>` and sends 401 if invalid.
 * Apply to all /api/* routes.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(req.headers['authorization']);
  if (!verifyToken(token)) {
    log.warn({ ip: req.ip, url: req.url }, 'rejected unauthenticated request');
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ── WebSocket token verification ──────────────────────────────────────────────

/**
 * Validate a token sent as the first WebSocket message or as a query parameter.
 * The caller is responsible for closing the socket on failure.
 *
 * Accepts:
 *   - Query param:  ?token=<value>
 *   - First message: JSON { type: "auth", token: "<value>" }
 *   - First message: bare string token
 */
export function verifyWsToken(candidate: string | null | undefined): boolean {
  if (!verifyToken(candidate)) {
    log.warn('rejected unauthenticated WebSocket connection');
    return false;
  }
  return true;
}

/** Parse a token out of a raw WebSocket message (first frame). */
export function parseWsAuthMessage(raw: string): string | null {
  // Try JSON first: { type: "auth", token: "..." }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'token' in parsed &&
      typeof (parsed as Record<string, unknown>)['token'] === 'string'
    ) {
      return (parsed as { token: string }).token.trim();
    }
  } catch {
    // Fall through — treat as bare token string
  }

  // Bare string token (trimmed)
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
