/**
 * Control Socket — singleton broadcaster for the active PWA control WebSocket.
 *
 * The control WS is established by the PWA on every page load and is the only
 * real-time channel back to the phone. Any server-side code that needs to push
 * data to the PWA (narration, approval requests, …) uses this module.
 *
 * The server.ts WS handler calls `registerControlSocket` when a session
 * authenticates and `registerControlSocket(null)` when it closes.
 */

import { childLogger } from '../log.js';

const log = childLogger('control-socket');

type SendFn = (data: string) => void;

let _send: SendFn | null = null;

/** Register (or deregister) the active control socket send function. */
export function registerControlSocket(send: SendFn | null): void {
  _send = send;
  if (send) {
    log.debug('control socket registered');
  } else {
    log.debug('control socket deregistered');
  }
}

/**
 * Push a JSON payload to the connected PWA.
 * Returns true if the socket was available and the message was sent.
 */
export function pushToPhone(payload: object): boolean {
  if (!_send) {
    log.warn({ type: (payload as Record<string, unknown>)['type'] }, 'pushToPhone: no control socket');
    return false;
  }
  try {
    _send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log.error({ err }, 'pushToPhone: send failed');
    return false;
  }
}

export function isControlSocketOpen(): boolean {
  return _send !== null;
}
