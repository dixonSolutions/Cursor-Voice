import { Injectable, computed, signal } from '@angular/core';

export type AppState = 'idle' | 'listening' | 'working';

export interface StatusDisplay {
  label: string;
  cssClass: string;
}

/**
 * Signal-based state machine for the PTT lifecycle.
 *
 *   idle ──tap──► listening ──tool call──► working
 *     ▲               │   ▲                   │
 *     └── tap/close ──┘   └─── result done ───┘
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
      case 'listening': return 'LISTENING…';
      case 'working':   return 'WORKING…';
    }
  });

  /** PTT button CSS class. */
  readonly pttClass = computed(() => this._state());

  transitionTo(next: AppState): void {
    this._state.set(next);
  }
}
