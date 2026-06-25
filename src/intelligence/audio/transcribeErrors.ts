/** Map AWS SDK / network errors to short user-facing STT messages. */
export function friendlyTranscribeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('http/2 stream') || lower.includes('abnormally aborted')) {
    return 'Transcription failed — the bridge could not reach AWS. Check container DNS and try again.';
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return 'Transcription failed — network error reaching AWS.';
  }
  if (lower.includes('too short')) {
    return message;
  }
  if (lower.includes('credentials') || lower.includes('unrecognizedclient') || lower.includes('access denied')) {
    return 'Transcription failed — check AWS credentials on the bridge.';
  }

  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}
