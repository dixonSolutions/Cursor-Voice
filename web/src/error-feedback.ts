/** Short spoken form for pipeline error messages. */
export function errorSpeechText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'Something went wrong.';
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}
