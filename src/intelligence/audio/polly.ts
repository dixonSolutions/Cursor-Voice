/**
 * Amazon Polly TTS for llm_intelligence fallback when WebKit speechSynthesis is unavailable.
 */

import {
  Engine,
  OutputFormat,
  PollyClient,
  SynthesizeSpeechCommand,
  type VoiceId,
} from '@aws-sdk/client-polly';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import { createPollyClient } from './awsClient.js';

const log = childLogger('intelligence:polly');

const MAX_POLLY_CHARS = 3000;

export interface PollySynthResult {
  audio: Buffer;
  contentType: 'audio/mpeg';
}

export async function synthesizePollyMp3(text: string): Promise<PollySynthResult> {
  const clean = text.trim().slice(0, MAX_POLLY_CHARS);
  if (!clean) {
    throw new Error('Polly text is empty');
  }

  const { pollyVoiceId, pollyEngine } = getConfig().settings.workflow.llmIntelligence.audio;
  const client = createPollyClient();

  try {
    const response = await client.send(
      new SynthesizeSpeechCommand({
        Text: clean,
        OutputFormat: OutputFormat.MP3,
        VoiceId: pollyVoiceId as VoiceId,
        Engine: pollyEngine as Engine,
      }),
    );

    const bytes = await response.AudioStream?.transformToByteArray();
    if (!bytes?.length) {
      throw new Error('Polly returned empty audio');
    }

    return { audio: Buffer.from(bytes), contentType: 'audio/mpeg' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'polly synthesis failed');
    throw new Error(`Polly TTS failed: ${message}`);
  } finally {
    client.destroy();
  }
}

export async function pingPolly(): Promise<void> {
  await synthesizePollyMp3('OK');
}
