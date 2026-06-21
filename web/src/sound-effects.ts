/**
 * Short UI cues for the voice pipeline.
 *
 * Assets: web/public/sounds/*.mp3 (Kenney UI Audio, CC0 — see sounds/README.md).
 * Regenerate: bash scripts/prepare-voice-cues.sh
 *
 * Use playVoiceCueNow() at recognition time (Vosk / VAD) — must not await STT.
 */
import { unlockAudioContext } from './audio.js';

export type VoiceCue = 'listening' | 'sent' | 'cancel' | 'error';

const CUE_FILES: Record<VoiceCue, string> = {
  listening: '/sounds/listening.mp3',
  sent: '/sounds/sent.mp3',
  cancel: '/sounds/cancel.mp3',
  error: '/sounds/error.mp3',
};

/** HTMLAudio volume cap (files are already boosted in prepare-voice-cues.sh). */
const PLAYBACK_VOLUME = 1;
const DEBOUNCE_MS = 450;

const lastPlayedAt: Partial<Record<VoiceCue, number>> = {};
const audioEls = new Map<VoiceCue, HTMLAudioElement>();

function getOrCreateAudio(cue: VoiceCue): HTMLAudioElement {
  let el = audioEls.get(cue);
  if (!el) {
    el = new Audio(CUE_FILES[cue]);
    el.preload = 'auto';
    audioEls.set(cue, el);
  }
  return el;
}

function primeAudioElement(el: HTMLAudioElement): Promise<void> {
  return new Promise((resolve) => {
    if (el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      resolve();
      return;
    }
    const done = () => resolve();
    el.addEventListener('canplaythrough', done, { once: true });
    el.addEventListener('error', done, { once: true });
    el.load();
  });
}

/** Preload after orb tap (user gesture). Keeps playVoiceCueNow() synchronous later. */
export async function preloadVoiceCues(): Promise<void> {
  try {
    await unlockAudioContext();
    await Promise.all(
      (Object.keys(CUE_FILES) as VoiceCue[]).map(async (cue) => {
        await primeAudioElement(getOrCreateAudio(cue));
      }),
    );
  } catch {
    // Best-effort — lazy load on first play.
  }
}

/**
 * Play immediately on recognition — no fetch/decode await.
 * Call from Vosk match / VAD speech-end handlers before STT flush.
 */
export function playVoiceCueNow(cue: VoiceCue, opts?: { force?: boolean }): void {
  try {
    const now = Date.now();
    if (!opts?.force) {
      const last = lastPlayedAt[cue];
      if (last !== undefined && now - last < DEBOUNCE_MS) return;
    }
    lastPlayedAt[cue] = now;

    const el = getOrCreateAudio(cue);
    el.volume = PLAYBACK_VOLUME;
    el.currentTime = 0;
    void el.play().catch(() => {
      // iOS may reject if context locked — retry after unlock.
      void unlockAudioContext().then(() => {
        el.currentTime = 0;
        void el.play().catch(() => undefined);
      });
    });
  } catch {
    // Never block voice pipeline.
  }
}

/** @deprecated Prefer playVoiceCueNow at recognition sites. */
export function playVoiceCue(cue: VoiceCue, opts?: { force?: boolean }): void {
  playVoiceCueNow(cue, opts);
}
