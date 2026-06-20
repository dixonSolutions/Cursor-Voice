/**
 * Push notification API — Web Push (PWA) and native token registration.
 */

import type { FastifyInstance } from 'fastify';
import { getVapidPublicKey } from '../push/webPush.js';
import { isApnsConfigured } from '../push/apns.js';
import {
  countPushSubscriptions,
  removePushSubscription,
  upsertNativePushToken,
  upsertWebPushSubscription,
} from '../state/pushStore.js';
import { getPendingApprovals } from '../mcp/server/approvalRegistry.js';
import { childLogger } from '../log.js';

const log = childLogger('push-routes');

export function registerPushRoutes(app: FastifyInstance): void {
  /** GET /api/push/config — VAPID public key + capability flags (authenticated). */
  app.get('/api/push/config', async () => {
    return {
      vapidPublicKey: getVapidPublicKey(),
      apnsConfigured: isApnsConfigured(),
      subscriptions: countPushSubscriptions(),
    };
  });

  /** POST /api/push/subscribe-web — register Web Push subscription from PWA SW. */
  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/api/push/subscribe-web',
    async (req, reply) => {
      const { endpoint, keys } = req.body ?? {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return reply.code(400).send({ error: 'Invalid push subscription' });
      }
      upsertWebPushSubscription({ endpoint, keys });
      log.info('web push subscription registered');
      return { ok: true };
    },
  );

  /** POST /api/push/register-native — register APNs/FCM device token from Capacitor app. */
  app.post<{
    Body: { platform: 'ios' | 'android' | 'ios_voip'; token: string; bundle_id?: string };
  }>('/api/push/register-native', async (req, reply) => {
    const { platform, token, bundle_id } = req.body ?? {};
    if (
      platform !== 'ios' &&
      platform !== 'android' &&
      platform !== 'ios_voip'
    ) {
      return reply.code(400).send({ error: 'platform and token required' });
    }
    if (!token?.trim()) {
      return reply.code(400).send({ error: 'platform and token required' });
    }
    upsertNativePushToken({ platform, token: token.trim(), bundle_id });
    return { ok: true };
  });

  /** DELETE /api/push/unsubscribe — remove a subscription endpoint. */
  app.delete<{ Body: { endpoint: string } }>('/api/push/unsubscribe', async (req, reply) => {
    const endpoint = req.body?.endpoint?.trim();
    if (!endpoint) return reply.code(400).send({ error: 'endpoint required' });
    removePushSubscription(endpoint);
    return { ok: true };
  });

  /** GET /api/pending-approvals — blocking agent requests waiting for user input. */
  app.get('/api/pending-approvals', async () => {
    return { pending: getPendingApprovals() };
  });
}
