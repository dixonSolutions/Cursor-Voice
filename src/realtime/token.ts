/**
 * Ephemeral token minting.
 *
 * The bridge calls the provider API to get a short-lived token that the
 * phone PWA uses to establish a WebRTC session directly with the provider.
 * The API key NEVER leaves the bridge.
 *
 * Flow:
 *   Phone  →  POST /api/realtime/token (Bearer app-token)
 *   Bridge →  provider.mintEphemeralToken(sessionConfig)
 *   Bridge ←  { token, expiresAt, sessionId }
 *   Phone  ←  { token, expiresAt }
 *   Phone  →  WebRTC connect to provider using token
 */

import { createProvider } from './provider.js';
import { buildSessionConfig } from './session.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('token');

// ── Lazy provider singleton ───────────────────────────────────────────────
// Initialised on first token request so the bridge starts even if no API key
// is set (health check still works, token endpoint fails cleanly).

let _provider: ReturnType<typeof createProvider> | null = null;

function getProvider(): ReturnType<typeof createProvider> {
  if (!_provider) {
    const { env, settings } = getConfig();
    _provider = createProvider(
      settings.voiceProvider,
      { OPENAI_API_KEY: env.OPENAI_API_KEY, GEMINI_API_KEY: env.GEMINI_API_KEY },
      settings.realtimeModel,
    );
    log.info({ provider: settings.voiceProvider, model: settings.realtimeModel }, 'voice provider initialised');
  }
  return _provider;
}

// ── Public API ────────────────────────────────────────────────────────────

export interface TokenResponse {
  token: string;
  expiresAt: number;
  sessionId: string;
  provider: string;
  /** Model identifier — must be passed to the SDP exchange URL. */
  model: string;
}

/**
 * Mint an ephemeral token for the phone.
 * Bakes the session config (system prompt + project catalog + tool definitions)
 * into the token so the phone can't tamper with capabilities.
 */
export async function mintToken(voice?: string): Promise<TokenResponse> {
  const provider = getProvider();
  const sessionConfig = buildSessionConfig(voice);

  log.debug('minting ephemeral provider token');
  const result = await provider.mintEphemeralToken(sessionConfig);

  log.info(
    { provider: provider.name, sessionId: result.sessionId, expiresAt: result.expiresAt },
    'token minted',
  );

  return {
    token: result.token,
    expiresAt: result.expiresAt,
    sessionId: result.sessionId,
    provider: provider.name,
    model: result.model,
  };
}
