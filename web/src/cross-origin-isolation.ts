/** Headers required for SharedArrayBuffer (vosk-browser WASM worker). */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

/** User-facing origin hint when COOP/COEP is missing (never hardcode dev ports). */
export function crossOriginIsolationHint(): string {
  if (typeof location !== 'undefined' && location.origin && location.protocol !== 'file:') {
    return location.origin;
  }
  return 'your deployed PWA URL';
}

export function wakePhraseCoopError(): string {
  return (
    `Wake phrase detection needs COOP/COEP headers — open ${crossOriginIsolationHint()} ` +
    '(not file:// or an embedded frame). Typed input still works.'
  );
}

export function voskCoopError(): string {
  return (
    `Vosk needs COOP/COEP headers — open ${crossOriginIsolationHint()} ` +
    '(not file:// or a cross-origin embed).'
  );
}
