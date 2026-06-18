/** Shared Vosk model — loaded once, reused for start/end grammar spotters. */

import type { Model } from 'vosk-browser';
import { VOSK_MODEL_URL } from './vosk-wake-word.js';

let modelPromise: Promise<Model> | null = null;

export function loadVoskModel(): Promise<Model> {
  if (!modelPromise) {
    modelPromise = import('vosk-browser').then((m) => {
      // esbuild bundles CJS modules as a default export only (`export default JU()`).
      // The named export `createModel` lives on `.default` in the bundled chunk,
      // but on the module namespace directly in Node / un-bundled ESM.
      // Fall back gracefully so the same code works in both environments.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = m as any;
      const createModel: (url: string) => Promise<Model> =
        mod.createModel ?? mod.default?.createModel;
      if (typeof createModel !== 'function') {
        throw new Error(
          'vosk-browser: createModel not found — check bundle output (CJS/ESM mismatch).',
        );
      }
      return createModel(VOSK_MODEL_URL);
    });
  }
  return modelPromise;
}

export function clearVoskModelCache(): void {
  modelPromise = null;
}
