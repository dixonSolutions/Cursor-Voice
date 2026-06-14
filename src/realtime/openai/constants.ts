/**
 * OpenAI Realtime API — GA (General Availability) constants.
 * @see https://developers.openai.com/api/docs/guides/realtime
 */

export const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** GA sessions require session.type === "realtime". */
export const OPENAI_SESSION_TYPE = 'realtime' as const;

export const DEFAULT_OPENAI_VOICE = 'alloy';

export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';
