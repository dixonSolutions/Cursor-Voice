/**
 * Push live tool-activity updates to the active Bedrock voice WebSocket.
 * Used when headless cursor-agent spawns (pid known after spawn, before tool returns).
 */

export interface VoiceToolActivityEvent {
  tool: string;
  phase: 'start' | 'done' | 'error';
  label: string;
  detail?: string;
}

type Broadcaster = (event: VoiceToolActivityEvent) => void;

let broadcaster: Broadcaster | null = null;

export function setVoiceToolActivityBroadcaster(cb: Broadcaster | null): void {
  broadcaster = cb;
}

export function emitVoiceToolActivity(event: VoiceToolActivityEvent): void {
  broadcaster?.(event);
}
