/**
 * OpenAI Realtime GA — browser-side helpers (WebRTC + data-channel events).
 */

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** GA server event types we handle (includes aliases during API transitions). */
export const OPENAI_SPEAKING_START = new Set([
  'response.output_audio.delta',
  'response.audio.delta',
]);

export const OPENAI_SPEAKING_END = new Set([
  'response.output_audio.done',
  'response.audio.done',
]);

export const OPENAI_USER_TRANSCRIPT = new Set([
  'conversation.item.input_audio_transcription.completed',
]);

export const OPENAI_ASSISTANT_TRANSCRIPT = new Set([
  'response.output_audio_transcript.done',
  'response.output_audio_transcription.done',
  'response.audio_transcript.done',
]);

export async function readHttpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof json.error === 'string') return json.error;
    if (json.error && typeof json.error === 'object' && json.error.message) {
      return json.error.message;
    }
  } catch {
    // fall through
  }
  return text || `${res.status} ${res.statusText}`;
}

export function extractTranscript(event: Record<string, unknown>): string {
  const direct = event['transcript'];
  if (typeof direct === 'string') return direct.trim();

  const item = event['item'] as Record<string, unknown> | undefined;
  const fromItem = item?.['transcript'];
  if (typeof fromItem === 'string') return fromItem.trim();

  return '';
}
