/**
 * Audio glue for Cursor Voice PWA.
 *
 * With WebRTC the browser handles Opus encoding, echo cancellation, jitter
 * buffering, and playback natively — so this module is intentionally thin.
 * Its job is iOS-specific workarounds:
 *
 *   1. AudioContext unlock — iOS Safari blocks audio until the first user
 *      gesture. We create/resume the context during the PTT tap handler
 *      so subsequent WebRTC audio output plays without user interaction.
 *
 *   2. Audio element factory — the remote track from the provider is
 *      attached to a plain <audio> element. `playsinline` is required on
 *      iOS to prevent audio from routing to the earpiece rather than the
 *      speaker, and to avoid switching the app into "phone call" mode.
 *
 * See docs/06-voice-audio-webrtc.md — "Audio specifics" section.
 */

let _audioCtx: AudioContext | null = null;

/**
 * Unlock the AudioContext inside a user-gesture handler.
 *
 * Must be called at the start of the PTT tap before any await, because
 * iOS only allows AudioContext creation/resumption synchronously within
 * the gesture stack. Safe to call multiple times.
 */
export async function unlockAudioContext(): Promise<void> {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    await _audioCtx.resume();
  }
}

/**
 * Create and attach an <audio> element for WebRTC remote-track playback.
 *
 * Call inside a user gesture so the initial play() call is permitted
 * (autoplay policy). The element is appended to the body so the browser
 * keeps it alive; call `.remove()` when the session ends.
 */
export function createAudioElement(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.autoplay = true;
  // Prevents iOS from routing audio to the earpiece / entering call mode
  el.setAttribute('playsinline', '');
  // For older WebKit
  el.setAttribute('webkit-playsinline', '');
  document.body.appendChild(el);
  return el;
}
