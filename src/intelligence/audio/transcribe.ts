/**
 * Amazon Transcribe streaming STT for llm_intelligence fallback when WebKit STT is unavailable.
 *
 * Accepts 16-bit PCM mono at 16 kHz (same as Bedrock voice uplink).
 */

import {
  LanguageCode,
  MediaEncoding,
  StartStreamTranscriptionCommand,
  type TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import { createTranscribeStreamingClient } from './awsClient.js';

const log = childLogger('intelligence:transcribe');

const CHUNK_BYTES = 6400; // 200 ms @ 16 kHz 16-bit mono

function languageCode(): LanguageCode {
  const code = getConfig().settings.workflow.llmIntelligence.audio.transcribeLanguageCode;
  return code as LanguageCode;
}

async function* pcmAudioStream(pcm: Buffer): AsyncGenerator<{ AudioEvent: { AudioChunk: Uint8Array } }> {
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    yield { AudioEvent: { AudioChunk: pcm.subarray(offset, offset + CHUNK_BYTES) } };
  }
}

export async function transcribePcm16(pcm: Buffer): Promise<string> {
  if (pcm.length < 3200) {
    throw new Error('Audio too short — speak for at least half a second');
  }

  const client = createTranscribeStreamingClient();
  try {
    return await runTranscribeStream(client, pcm);
  } finally {
    client.destroy();
  }
}

async function runTranscribeStream(client: TranscribeStreamingClient, pcm: Buffer): Promise<string> {
  const command = new StartStreamTranscriptionCommand({
    LanguageCode: languageCode(),
    MediaEncoding: MediaEncoding.PCM,
    MediaSampleRateHertz: 16000,
    AudioStream: pcmAudioStream(pcm),
  });

  const response = await client.send(command);
  const parts: string[] = [];

  for await (const event of response.TranscriptResultStream ?? []) {
    const results = event.TranscriptEvent?.Transcript?.Results;
    if (!results) continue;
    for (const result of results) {
      if (result.IsPartial) continue;
      const text = result.Alternatives?.[0]?.Transcript?.trim();
      if (text) parts.push(text);
    }
  }

  const transcript = parts.join(' ').trim();
  if (!transcript) {
    log.debug({ pcmBytes: pcm.length }, 'transcribe returned empty');
  }
  return transcript;
}
