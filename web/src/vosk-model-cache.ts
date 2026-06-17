/** Shared Vosk model — loaded once, reused for start/end grammar spotters. */

import type { Model } from 'vosk-browser';
import { VOSK_MODEL_URL } from './vosk-wake-word.js';

let modelPromise: Promise<Model> | null = null;

export function loadVoskModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = import('vosk-browser').then(({ createModel }) => createModel(VOSK_MODEL_URL));
  }
  return modelPromise;
}

export function clearVoskModelCache(): void {
  modelPromise = null;
}
