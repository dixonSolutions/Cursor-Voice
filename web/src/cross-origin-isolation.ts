/** Headers required for SharedArrayBuffer (vosk-browser WASM worker). */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}
