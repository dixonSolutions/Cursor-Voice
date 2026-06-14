/**
 * Voice provider abstraction + implementations.
 *
 * OpenAI Realtime is the primary WebRTC implementation.
 * Amazon Bedrock Nova Sonic uses bridge-side bidirectional streaming (/ws/voice).
 * Gemini and Anthropic remain stubbed for token mint.
 *
 * Provider selection comes from config.json (defaultProvider + defaultModel).
 * API keys come from .env only — see provider_keys.ts for schemas.
 *
 * See docs/06-voice-audio-webrtc.md and docs/13-voice-providers.md.
 */

import type { ProviderId } from './provider_keys.js';
import { DEFAULT_AWS_REGION } from './provider_keys.js';
import { randomUUID } from 'node:crypto';
import { registerPendingBedrockSession } from './bedrock/pendingSessions.js';
import type { BedrockAuth } from './bedrock/credentials.js';
import { resolveBedrockAuth, validateBedrockCredentials } from './bedrock/credentials.js';
import { mintOpenAiRealtimeToken } from './openai/mintToken.js';

// ── Provider interface ────────────────────────────────────────────────────

export type VoiceTransport = 'webrtc' | 'bedrock_ws';

export interface EphemeralTokenResponse {
  token: string;
  expiresAt: number;
  sessionId: string;
  model: string;
  transport: VoiceTransport;
}

export interface SessionConfig {
  instructions: string;
  voice: string;
  tools: unknown[];
  languages?: string[];
}

export interface VoiceProvider {
  readonly id: ProviderId;
  readonly name: string;
  mintEphemeralToken(config: SessionConfig): Promise<EphemeralTokenResponse>;
}

// ── OpenAI Realtime ───────────────────────────────────────────────────────

export class OpenAIRealtimeProvider implements VoiceProvider {
  readonly id = 'openai' as const;
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async mintEphemeralToken(config: SessionConfig): Promise<EphemeralTokenResponse> {
    return mintOpenAiRealtimeToken(this.apiKey, this.model, config);
  }
}

// ── Gemini Live (stub) ────────────────────────────────────────────────────

export class GeminiLiveProvider implements VoiceProvider {
  readonly id = 'gemini' as const;
  readonly name = 'gemini';

  constructor(
    private readonly _apiKey: string,
    private readonly model: string,
  ) {}

  async mintEphemeralToken(_config: SessionConfig): Promise<EphemeralTokenResponse> {
    throw new Error(
      `Gemini Live token mint not yet implemented (model: ${this.model}). ` +
        'OpenAI is the only working WebRTC provider today.',
    );
  }
}

// ── Anthropic (stub) ──────────────────────────────────────────────────────

export class AnthropicVoiceProvider implements VoiceProvider {
  readonly id = 'anthropic' as const;
  readonly name = 'anthropic';

  constructor(
    private readonly _apiKey: string,
    private readonly model: string,
  ) {}

  async mintEphemeralToken(_config: SessionConfig): Promise<EphemeralTokenResponse> {
    throw new Error(
      `Anthropic voice token mint not yet implemented (model: ${this.model}). ` +
        'Register the provider for config testing; use OpenAI for live voice.',
    );
  }
}

// ── Amazon Bedrock (stub) ─────────────────────────────────────────────────

export class BedrockVoiceProvider implements VoiceProvider {
  readonly id = 'amazon_bedrock' as const;
  readonly name = 'amazon_bedrock';

  constructor(
    private readonly bedrockAuth: BedrockAuth,
    private readonly region: string,
    private readonly model: string,
  ) {}

  async mintEphemeralToken(config: SessionConfig): Promise<EphemeralTokenResponse> {
    await validateBedrockCredentials(this.region, this.bedrockAuth);

    const sessionId = randomUUID();
    registerPendingBedrockSession(sessionId, this.model, this.region, config);

    return {
      token: sessionId,
      expiresAt: Math.floor(Date.now() / 1000) + 480,
      sessionId,
      model: this.model,
      transport: 'bedrock_ws',
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export interface ProviderEnv {
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
}

export function createProvider(
  providerId: ProviderId,
  env: ProviderEnv,
  model: string,
): VoiceProvider {
  switch (providerId) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required (set in .env)');
      }
      return new OpenAIRealtimeProvider(env.OPENAI_API_KEY, model);
    }
    case 'gemini': {
      if (!env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required (set in .env)');
      }
      return new GeminiLiveProvider(env.GEMINI_API_KEY, model);
    }
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is required (set in .env)');
      }
      return new AnthropicVoiceProvider(env.ANTHROPIC_API_KEY, model);
    }
    case 'amazon_bedrock': {
      let auth: BedrockAuth;
      try {
        auth = resolveBedrockAuth(env);
      } catch {
        throw new Error(
          'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for Nova Sonic voice (Bedrock API keys are not supported).',
        );
      }
      return new BedrockVoiceProvider(
        auth,
        env.AWS_REGION ?? DEFAULT_AWS_REGION,
        model,
      );
    }
    default: {
      const _exhaustive: never = providerId;
      throw new Error(`Unknown voice provider: ${_exhaustive}`);
    }
  }
}
