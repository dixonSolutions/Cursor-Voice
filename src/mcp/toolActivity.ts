/**
 * Tool activity bus — UI visibility for voice tool calls (Bedrock + relay paths).
 */

import type { ToolActivityEvent } from './toolVoice/types.js';

type Listener = (event: ToolActivityEvent) => void;

const listeners = new Set<Listener>();

export function subscribeToolActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitToolActivity(event: ToolActivityEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}
