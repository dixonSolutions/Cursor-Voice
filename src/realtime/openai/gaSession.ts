/**
 * Build the POST body for OpenAI GA Realtime client_secrets.
 *
 * Preview/beta used flat fields (input_audio_transcription, turn_detection).
 * GA nests audio config under session.audio.input / session.audio.output.
 */

import type { SessionConfig } from '../provider.js';
import {
  DEFAULT_OPENAI_VOICE,
  DEFAULT_TRANSCRIPTION_MODEL,
  OPENAI_SESSION_TYPE,
} from './constants.js';

export interface OpenAiClientSecretRequest {
  session: {
    type: typeof OPENAI_SESSION_TYPE;
    model: string;
    instructions: string;
    tools: unknown[];
    audio: {
      input: {
        transcription: { model: string };
        turn_detection: { type: 'server_vad' };
      };
      output: { voice: string };
    };
    output_modalities: ['audio'];
  };
}

export interface OpenAiClientSecretResponse {
  value: string;
  expires_at: number;
  session: { id: string };
}

/** Map bridge session config → OpenAI GA client_secrets body. */
export function buildOpenAiClientSecretBody(
  model: string,
  config: SessionConfig,
): OpenAiClientSecretRequest {
  return {
    session: {
      type: OPENAI_SESSION_TYPE,
      model,
      instructions: config.instructions,
      tools: config.tools,
      audio: {
        input: {
          transcription: { model: DEFAULT_TRANSCRIPTION_MODEL },
          turn_detection: { type: 'server_vad' },
        },
        output: { voice: config.voice || DEFAULT_OPENAI_VOICE },
      },
      output_modalities: ['audio'],
    },
  };
}

export function parseOpenAiClientSecretResponse(raw: unknown): OpenAiClientSecretResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OpenAI client_secrets returned non-object response');
  }
  const data = raw as Record<string, unknown>;
  const value = data['value'];
  const expiresAt = data['expires_at'];
  const session = data['session'] as Record<string, unknown> | undefined;
  const sessionId = session?.['id'];

  if (typeof value !== 'string' || !value) {
    throw new Error('OpenAI client_secrets missing value (ephemeral token)');
  }
  if (typeof expiresAt !== 'number') {
    throw new Error('OpenAI client_secrets missing expires_at');
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('OpenAI client_secrets missing session.id');
  }

  return {
    value,
    expires_at: expiresAt,
    session: { id: sessionId },
  };
}

export async function readOpenAiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {
    // fall through
  }
  return text || res.statusText;
}
