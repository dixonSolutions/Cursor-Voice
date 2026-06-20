/**
 * Push subscription storage — Web Push (PWA) and native APNs/FCM tokens.
 */

import { getDb } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('push-store');

export type PushPlatform = 'web' | 'ios' | 'android' | 'ios_voip';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NativePushToken {
  platform: 'ios' | 'android' | 'ios_voip';
  token: string;
  bundle_id?: string;
}

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS push_subscription (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform    TEXT NOT NULL,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT,
    auth        TEXT,
    token       TEXT,
    bundle_id   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_platform ON push_subscription(platform);
`;

let migrated = false;

function ensureTable(): void {
  if (migrated) return;
  getDb().exec(MIGRATION);
  migrated = true;
}

export function upsertWebPushSubscription(sub: WebPushSubscription): void {
  ensureTable();
  getDb()
    .prepare(
      `INSERT INTO push_subscription (platform, endpoint, p256dh, auth, token)
       VALUES ('web', @endpoint, @p256dh, @auth, NULL)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         updated_at = datetime('now')`,
    )
    .run({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    });
  log.info('web push subscription saved');
}

export function upsertNativePushToken(entry: NativePushToken): void {
  ensureTable();
  const endpoint = `${entry.platform}:${entry.token}`;
  getDb()
    .prepare(
      `INSERT INTO push_subscription (platform, endpoint, p256dh, auth, token, bundle_id)
       VALUES (@platform, @endpoint, NULL, NULL, @token, @bundle_id)
       ON CONFLICT(endpoint) DO UPDATE SET
         token = excluded.token,
         bundle_id = excluded.bundle_id,
         updated_at = datetime('now')`,
    )
    .run({
      platform: entry.platform,
      endpoint,
      token: entry.token,
      bundle_id: entry.bundle_id ?? null,
    });
  log.info({ platform: entry.platform }, 'native push token saved');
}

export function removePushSubscription(endpoint: string): void {
  ensureTable();
  getDb().prepare(`DELETE FROM push_subscription WHERE endpoint = @endpoint`).run({ endpoint });
}

export function listPushSubscriptions(): Array<{
  platform: PushPlatform;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  token: string | null;
  bundle_id: string | null;
}> {
  ensureTable();
  return getDb()
    .prepare(
      `SELECT platform, endpoint, p256dh, auth, token, bundle_id FROM push_subscription`,
    )
    .all() as Array<{
    platform: PushPlatform;
    endpoint: string;
    p256dh: string | null;
    auth: string | null;
    token: string | null;
    bundle_id: string | null;
  }>;
}

export function countPushSubscriptions(): number {
  ensureTable();
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM push_subscription`)
    .get() as { n: number };
  return row.n;
}
