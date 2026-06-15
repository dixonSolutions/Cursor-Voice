/** Add speak_to_user hints so the voice model knows it must respond — no scripted TTS. */

export function enrichToolResultForVoice(
  _tool: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof result['speak_to_user'] === 'string') {
    return result;
  }
  if (typeof result['message'] === 'string') {
    return { ...result, speak_to_user: result['message'] };
  }
  if (typeof result['error'] === 'string') {
    return {
      ...result,
      speak_to_user: 'The tool failed. Explain the error briefly to the user.',
    };
  }
  return {
    ...result,
    speak_to_user:
      'Summarize this tool result for the user in your own words. Do not stay silent.',
  };
}
