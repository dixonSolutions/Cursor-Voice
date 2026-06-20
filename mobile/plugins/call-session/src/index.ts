import { registerPlugin } from '@capacitor/core';
import type { CallSessionPlugin } from './definitions.js';

export * from './definitions.js';

export const CallSession = registerPlugin<CallSessionPlugin>('CallSession');
