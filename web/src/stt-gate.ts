/**
 * Shared STT gating — Vosk gates wake/end; STT only captures during an utterance.
 */

export interface SttGate {
  /** Vosk opened the utterance — buffer audio for transcription. */
  isCapturing: () => boolean;
  /** Pause capture during TTS, orchestrator work, or between utterances. */
  isPaused: () => boolean;
}

/** Stricter VAD before wake word — ignore short background blips. */
export const STT_WAKE_SPEECH_RMS = 0.012;
export const STT_ACTIVE_SPEECH_RMS = 0.01;
export const STT_WAKE_MIN_PCM_BYTES = 8000;
export const STT_ACTIVE_MIN_PCM_BYTES = 6000;

export function speechRmsThreshold(activated: boolean): number {
  return activated ? STT_ACTIVE_SPEECH_RMS : STT_WAKE_SPEECH_RMS;
}

export function minPcmBytes(activated: boolean): number {
  return activated ? STT_ACTIVE_MIN_PCM_BYTES : STT_WAKE_MIN_PCM_BYTES;
}
