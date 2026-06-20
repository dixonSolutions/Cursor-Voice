/** Client-side mirror of src/voice/ttsInterrupt.ts */

export interface TtsInterruptSnapshot {
  heard_complete: string[];
  heard_partial: string | null;
  not_spoken: string[];
}

export interface TtsVolumeControl {
  /** Effective multiplier 0–1 applied to this playback. */
  setVolume(multiplier: number): void;
}

export interface TtsPlayContext {
  onStart: () => void;
  signal: AbortSignal;
  /** Live volume control for ducking during barge-in. */
  volume: TtsVolumeControl;
  /** Base volume from browser TTS settings (before interrupt ducking). */
  baseVolume: number;
}

export type TtsPlayFn = (text: string, ctx: TtsPlayContext) => Promise<void>;

export function snapshotToPayload(
  snap: TtsInterruptSnapshot,
): TtsInterruptSnapshot | undefined {
  if (!snap.heard_complete.length && !snap.heard_partial && !snap.not_spoken.length) {
    return undefined;
  }
  return snap;
}

export function summarizeTtsInterrupt(snap: TtsInterruptSnapshot): string {
  const parts: string[] = [];
  if (snap.heard_complete.length) {
    const tail = snap.heard_complete[snap.heard_complete.length - 1] ?? '';
    parts.push(
      snap.heard_complete.length === 1
        ? `last full line: "${tail.slice(0, 80)}${tail.length > 80 ? '…' : ''}"`
        : `${snap.heard_complete.length} full lines`,
    );
  }
  if (snap.heard_partial) {
    parts.push(`cut off: "${snap.heard_partial.slice(0, 60)}${snap.heard_partial.length > 60 ? '…' : ''}"`);
  }
  if (snap.not_spoken.length) {
    parts.push(`${snap.not_spoken.length} line(s) not played`);
  }
  return parts.join(' · ') || 'assistant speech stopped';
}
