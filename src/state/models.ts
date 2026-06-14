/**
 * Model cache DB helpers.
 *
 * cursor-agent models output is cached in the `model_cache` single-row table
 * to avoid shelling out on every request. TTL is configurable in config.json
 * (default 1 hour).
 */

import { getDb } from './db.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('models');

export interface ModelEntry {
  id: string;
  displayName: string;
}

interface ModelCacheRow {
  id: number;
  fetched_at: string;
  models_json: string;
}

// ── Read / write cache ────────────────────────────────────────────────────

/** Return cached models if fresh, null if stale or absent. */
export function getCachedModels(): ModelEntry[] | null {
  const row = getDb()
    .prepare('SELECT * FROM model_cache WHERE id = 1')
    .get() as ModelCacheRow | undefined;

  if (!row) return null;

  const { settings } = getConfig();
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > settings.modelCacheTtlMs) {
    log.debug({ ageMs: age, ttlMs: settings.modelCacheTtlMs }, 'model cache stale');
    return null;
  }

  try {
    return JSON.parse(row.models_json) as ModelEntry[];
  } catch {
    return null;
  }
}

/** Write / replace the model cache. */
export function setModelCache(models: ModelEntry[]): void {
  getDb()
    .prepare(
      `INSERT INTO model_cache (id, fetched_at, models_json)
       VALUES (1, datetime('now'), @json)
       ON CONFLICT(id) DO UPDATE SET
         fetched_at  = excluded.fetched_at,
         models_json = excluded.models_json`,
    )
    .run({ json: JSON.stringify(models) });
  log.info({ count: models.length }, 'model cache updated');
}

/** Fuzzy-contains filter: matches id or displayName case-insensitively. */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const q = query.toLowerCase();
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
  );
}

/** Validate that a model ID exists in a list. */
export function isValidModelId(models: ModelEntry[], id: string): boolean {
  return models.some((m) => m.id === id);
}
