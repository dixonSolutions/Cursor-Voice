import { Injectable, inject } from '@angular/core';
import { BridgeService } from './bridge.service';
import { registerPushNotifications } from '../../native/push-registration.js';
import type { ApprovalRequest } from './bridge.service';

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly bridge = inject(BridgeService);
  private registered = false;

  async ensureRegistered(): Promise<void> {
    if (this.registered || !this.bridge.hasCredentials()) return;
    try {
      await registerPushNotifications(this.bridge.bridgeBase, this.bridge.appToken);
      this.registered = true;
    } catch {
      // Non-fatal — push is optional until VAPID/APNs configured.
    }
  }

  /** Load approvals that arrived while the app was backgrounded or killed. */
  async syncPendingApprovals(): Promise<void> {
    if (!this.bridge.hasCredentials()) return;
    try {
      const data = await this.bridge.apiFetch<{ pending: ApprovalRequest[] }>(
        '/api/pending-approvals',
      );
      const first = data.pending[0];
      if (first && !this.bridge.pendingApproval()) {
        this.bridge.pendingApproval.set(first);
      }
    } catch {
      // ignore
    }
  }
}
