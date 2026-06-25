/** Short spoken form for pipeline error messages. */
export function errorSpeechText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'Something went wrong.';
  const lower = trimmed.toLowerCase();
  if (lower.includes('http/2 stream') || lower.includes('abnormally aborted')) {
    return 'Transcription failed. Check the bridge network and try again.';
  }
  if (lower.includes('could not reach aws') || lower.includes('network error reaching aws')) {
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  }
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}
