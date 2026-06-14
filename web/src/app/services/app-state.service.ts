import { Injectable, computed, signal } from '@angular/core';

export type AppState = 'idle' | 'inactive' | 'listening' | 'working';

export interface StatusDisplay {
  label: string;
  cssClass: string;
}

/**
 * Signal-based state machine for the PTT lifecycle.
 *
 *   idle ──tap──► inactive ──"cursor listen"──► listening
 *     ▲               │   ▲                        │
 *     └── tap/close ──┘   └── "cursor stop" ───────┘
 *                         (session stays open; mic stays on)
 *   listening/working ──job──► working (say "cursor listen" again after stop)
 */
@Injectable({ providedIn: 'root' })
export class AppStateService {
  private readonly _state = signal<AppState>('idle');

  /** Current PTT state — read-only externally. */
  readonly state = this._state.asReadonly();

  /** PTT button label derived from state. */
  readonly pttLabel = computed(() => {
    switch (this._state()) {
      case 'idle':      return 'TAP TO TALK';
      case 'inactive':  return 'MIC ON — SAY TO ACTIVATE';
      case 'listening': return 'LISTENING…';
      case 'working':   return 'CURSOR WORKING';
    }
  });

  /** PTT button CSS class. */
  readonly pttClass = computed(() => this._state());

  transitionTo(next: AppState): void {
    this._state.set(next);
  }
}
