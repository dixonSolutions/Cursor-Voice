/**
 * Native CallKit / foreground-call bridge — no-op on web/PWA.
 */

import { registerPlugin } from '@capacitor/core';

export interface CallSessionPlugin {
  startCall(): Promise<void>;
  endCall(): Promise<void>;
  isCallActive(): Promise<{ active: boolean }>;
  addListener(
    event: 'callEnded' | 'incomingCallAnswered' | 'audioSessionActivated' | 'voipToken',
    handler: (data: Record<string, string>) => void,
  ): Promise<{ remove: () => void }>;
}

const webStub: CallSessionPlugin = {
  startCall: async () => {},
  endCall: async () => {},
  isCallActive: async () => ({ active: false }),
  addListener: async () => ({ remove: () => {} }),
};

export const CallSession = registerPlugin<CallSessionPlugin>('CallSession', {
  web: () => Promise.resolve(webStub),
});

export function isNativeShell(): boolean {
  try {
    // Dynamic import avoided — Capacitor sets window.Capacitor at runtime in native shell.
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}
