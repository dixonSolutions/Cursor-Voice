/**
 * Mint an ephemeral OpenAI Realtime client secret (GA API).
 */

import type { EphemeralTokenResponse, SessionConfig } from '../provider.js';
import { OPENAI_REALTIME_CLIENT_SECRETS_URL } from './constants.js';
import {
  buildOpenAiClientSecretBody,
  parseOpenAiClientSecretResponse,
  readOpenAiError,
} from './gaSession.js';

export async function mintOpenAiRealtimeToken(
  apiKey: string,
  model: string,
  config: SessionConfig,
): Promise<EphemeralTokenResponse> {
  const body = buildOpenAiClientSecretBody(model, config);

  const res = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await readOpenAiError(res);
    throw new Error(`OpenAI token mint failed (${res.status}): ${detail}`);
  }

  const data = parseOpenAiClientSecretResponse(await res.json());

  return {
    token: data.value,
    expiresAt: data.expires_at,
    sessionId: data.session.id,
    model,
    transport: 'webrtc',
  };
}
