/**
 * Ephemeral token minting.
 *
 * Uses the active provider from config.json (defaultProvider + defaultModel).
 * API keys never leave the bridge — only short-lived tokens reach the phone.
 */

import { createProvider } from './provider.js';
import { buildSessionConfig } from './session.js';
import { getConfig } from '../config.js';
import { resolveActiveVoiceProvider } from './providerRegistry.js';
import { getWakeWordsFromConfig } from './session.js';
import { childLogger } from '../log.js';

const log = childLogger('token');

let _provider: ReturnType<typeof createProvider> | null = null;
let _providerKey: string | null = null;

function providerCacheKey(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function getProvider(): ReturnType<typeof createProvider> {
  const { providerId, model } = resolveActiveVoiceProvider();
  const key = providerCacheKey(providerId, model);

  if (!_provider || _providerKey !== key) {
    const { env } = getConfig();
    _provider = createProvider(providerId, env, model);
    _providerKey = key;
    log.info({ provider: providerId, model }, 'voice provider initialised');
  }

  return _provider;
}

/** Clear cached provider after config.json or default provider changes. */
export function resetVoiceProvider(): void {
  _provider = null;
  _providerKey = null;
}

export interface TokenResponse {
  token: string;
  expiresAt: number;
  sessionId: string;
  provider: string;
  model: string;
  transport: 'webrtc' | 'bedrock_ws';
  wakeWords: { start: string };
}

export async function mintToken(voice?: string): Promise<TokenResponse> {
  const provider = getProvider();
  const sessionConfig = buildSessionConfig(voice);

  log.debug('minting ephemeral provider token');
  const result = await provider.mintEphemeralToken(sessionConfig);

  log.info(
    { provider: provider.id, sessionId: result.sessionId, expiresAt: result.expiresAt },
    'token minted',
  );

  return {
    token: result.token,
    expiresAt: result.expiresAt,
    sessionId: result.sessionId,
    provider: provider.id,
    model: result.model,
    transport: result.transport,
    wakeWords: getWakeWordsFromConfig(),
  };
}

/** True when at least one registered provider is viable for token minting. */
export function hasViableVoiceProvider(): boolean {
  try {
    resolveActiveVoiceProvider();
    return true;
  } catch {
    return false;
  }
}
