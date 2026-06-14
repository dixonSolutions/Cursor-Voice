/**
 * Voice provider abstraction.
 *
 * Defines the interface that OpenAI Realtime (primary) and Gemini Live
 * (alternative) must implement. The bridge only talks to this interface,
 * so swapping providers is a one-file change.
 *
 * Confirmed primary: OpenAI Realtime GA (not the beta schema).
 * Documented alternative: Gemini Live (multilingual; handles Polish + English).
 *
 * See docs/06-voice-audio-webrtc.md for the full WebRTC + token flow.
 */

// ── Provider interface ────────────────────────────────────────────────────

export interface EphemeralTokenResponse {
  /** Short-lived token the phone uses to establish the WebRTC session. */
  token: string;
  /** Unix timestamp (seconds) when the token expires. */
  expiresAt: number;
  /** Session ID assigned by the provider (for debugging). */
  sessionId: string;
  /**
   * Model used when minting the token — must match the model parameter
   * in the SDP exchange URL (`POST /v1/realtime?model=...`).
   */
  model: string;
}

export interface SessionConfig {
  /** System prompt injected at session creation. */
  instructions: string;
  /** Provider voice ID (e.g. "alloy", "echo"). */
  voice: string;
  /** Function-tool definitions baked into the token. */
  tools: unknown[];
  /** Language hints (e.g. ['en', 'pl']). */
  languages?: string[];
}

export interface VoiceProvider {
  readonly name: string;

  /**
   * Mint a short-lived ephemeral token for the phone to use with WebRTC.
   * The API key NEVER leaves the bridge.
   */
  mintEphemeralToken(config: SessionConfig): Promise<EphemeralTokenResponse>;
}

// ── OpenAI Realtime provider ──────────────────────────────────────────────

export class OpenAIRealtimeProvider implements VoiceProvider {
  readonly name = 'openai';

  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string = 'gpt-4o-realtime-preview') {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * POST https://api.openai.com/v1/realtime/sessions
   *
   * GA schema (NOT the beta "conversation" schema):
   *   - session.type: "realtime"
   *   - audio under session.audio.input / session.audio.output
   *   - output_modalities (not top-level modalities)
   *   - Do NOT send OpenAI-Beta: realtime=v1
   *
   * Returns: { id, client_secret: { value, expires_at } }
   */
  async mintEphemeralToken(config: SessionConfig): Promise<EphemeralTokenResponse> {
    const body = {
      model: this.model,
      voice: config.voice,
      instructions: config.instructions,
      tools: config.tools,
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: { type: 'server_vad' },
      output_modalities: ['audio', 'text'],
    };

    const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        // GA: do NOT include OpenAI-Beta: realtime=v1
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI token mint failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      id: string;
      client_secret: { value: string; expires_at: number };
    };

    return {
      token: data.client_secret.value,
      expiresAt: data.client_secret.expires_at,
      sessionId: data.id,
      model: this.model,
    };
  }
}

// ── Gemini Live provider stub ─────────────────────────────────────────────
// Documented alternative for multilingual (Polish + English) deployments.
// Implement when Gemini Live GA API is confirmed.

export class GeminiLiveProvider implements VoiceProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'gemini-live',
  ) {}

  async mintEphemeralToken(_config: SessionConfig): Promise<EphemeralTokenResponse> {
    throw new Error(
      'Gemini Live provider not yet implemented. ' +
        'Set VOICE_PROVIDER=openai in config.json to use OpenAI Realtime.',
    );
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/** Create the configured provider instance. Throws if the API key is missing. */
export function createProvider(
  providerName: 'openai' | 'gemini',
  env: { OPENAI_API_KEY?: string; GEMINI_API_KEY?: string },
  model?: string,
): VoiceProvider {
  switch (providerName) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is required for voiceProvider=openai (set in .env)');
      }
      return new OpenAIRealtimeProvider(env.OPENAI_API_KEY, model);
    }
    case 'gemini': {
      if (!env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required for voiceProvider=gemini (set in .env)');
      }
      return new GeminiLiveProvider(env.GEMINI_API_KEY, model);
    }
    default: {
      const _exhaustive: never = providerName;
      throw new Error(`Unknown voice provider: ${_exhaustive}`);
    }
  }
}
