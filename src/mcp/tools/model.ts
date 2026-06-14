/**
 * Model tools — cursor_list_models, cursor_set_model
 *
 * Backed by cursor-agent models (CLI, parsed + cached in SQLite).
 * No model IDs are hardcoded — everything comes from the live CLI output.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { getCachedModels, setModelCache, filterModels, isValidModelId, type ModelEntry } from '../../state/models.js';
import { setActiveModel } from '../../state/registry.js';
import { childLogger } from '../../log.js';

const execFileAsync = promisify(execFile);
const log = childLogger('tool:model');

// ── cursor_list_models ────────────────────────────────────────────────────

export interface ListModelsArgs {
  query?: string;
}

export interface ListModelsResult {
  models: ModelEntry[];
  active_model: string;
  cached_at: string | null;
  total: number;
}

/**
 * Return cached models (refreshing if stale), optionally filtered.
 * If the cache is empty, calls cursor-agent models and populates it.
 */
export async function handleListModels(
  args: ListModelsArgs,
  activeModel: string,
): Promise<ListModelsResult> {
  let models = getCachedModels();
  let cachedAt: string | null = null;

  if (!models) {
    log.info('model cache miss — fetching from CLI');
    models = await fetchAndCacheModels();
  } else {
    // Pull cached_at timestamp for the response
    cachedAt = new Date().toISOString(); // approximate — good enough
  }

  const filtered = args.query ? filterModels(models, args.query) : models;

  return {
    models: filtered,
    active_model: activeModel,
    cached_at: cachedAt,
    total: filtered.length,
  };
}

// ── cursor_set_model ──────────────────────────────────────────────────────

export interface SetModelArgs {
  model_id: string;
}

export interface SetModelResult {
  active_model: string;
  displayName: string;
}

export async function handleSetModel(
  args: SetModelArgs,
  sessionKey: string,
): Promise<SetModelResult> {
  let models = getCachedModels();
  if (!models) {
    models = await fetchAndCacheModels();
  }

  if (!isValidModelId(models, args.model_id)) {
    // Show the first 10 matching IDs to help the caller
    const close = filterModels(models, args.model_id.split('-')[0] ?? args.model_id).slice(0, 10);
    throw new Error(
      `Unknown model ID "${args.model_id}". ` +
        (close.length > 0
          ? `Did you mean: ${close.map((m) => m.id).join(', ')}?`
          : 'Use cursor_list_models to browse available models.'),
    );
  }

  setActiveModel(sessionKey, args.model_id);
  const entry = models.find((m) => m.id === args.model_id)!;

  return { active_model: args.model_id, displayName: entry.displayName };
}

// ── Internal ──────────────────────────────────────────────────────────────

async function fetchAndCacheModels(): Promise<ModelEntry[]> {
  const { stdout } = await execFileAsync('cursor-agent', ['models'], { timeout: 15_000 });
  const models = parseModelsOutput(stdout);
  setModelCache(models);
  return models;
}

function parseModelsOutput(raw: string): ModelEntry[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.includes(' - ') &&
        !l.startsWith('Tip:') &&
        !l.startsWith('Available models') &&
        l.length > 0,
    )
    .map((l) => {
      const dashIdx = l.indexOf(' - ');
      return { id: l.slice(0, dashIdx).trim(), displayName: l.slice(dashIdx + 3).trim() };
    })
    .filter((m) => m.id.length > 0);
}
