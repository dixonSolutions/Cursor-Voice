/**
 * Voice provider registry — merges `.env` viability with `config.json` preferences.
 *
 * Layers:
 *   1. Catalog (provider_keys.ts) — fixed list of providers + known models
 *   2. Viability (.env) — keys present and valid → provider CAN be used
 *   3. Configuration (config.json) — registered providers, model lists, defaults
 *
 * The web app manages layer 3; layer 2 is read-only status (keys updated via API
 * that writes .env, never reads values back).
 */

import { z } from 'zod';
import {
  PROVIDER_DEFINITIONS,
  getProviderDefinition,
  isProviderId,
  type KnownModel,
  type ProviderId,
} from './provider_keys.js';
import { getConfig, reloadConfig, type TurnSubmit, type VoiceProviderConfig, type VoiceSettings, type VoiceSettingsInput, type WakeWords } from '../config.js';
import { isProviderViable, getProviderKeyStatus } from '../state/envFile.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { resetVoiceProvider } from './token.js';
import { writeAudit } from '../state/db.js';
import { childLogger } from '../log.js';

const log = childLogger('providerRegistry');

// ── API response shapes (safe for web — no secrets) ───────────────────────

export interface CatalogProvider {
  id: ProviderId;
  displayName: string;
  description: string;
  envKeys: Array<{
    envVar: string;
    label: string;
    secret: boolean;
    optional: boolean;
  }>;
  knownModels: KnownModel[];
}

export interface ConfiguredModel {
  id: string;
  label: string;
  builtin: boolean;
}

export interface ProviderView {
  id: ProviderId;
  displayName: string;
  description: string;
  registered: boolean;
  viable: boolean;
  isDefault: boolean;
  defaultModel: string | null;
  models: ConfiguredModel[];
  keyStatus: ReturnType<typeof getProviderKeyStatus>;
}

export interface VoiceProvidersResponse {
  defaultProvider: ProviderId;
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  catalog: CatalogProvider[];
  providers: ProviderView[];
  availableToRegister: ProviderId[];
}

// ── Catalog ───────────────────────────────────────────────────────────────

export function getCatalog(): CatalogProvider[] {
  return PROVIDER_DEFINITIONS.map((d) => ({
    id: d.id,
    displayName: d.displayName,
    description: d.description,
    envKeys: d.envKeys.map((k) => ({
      envVar: k.envVar,
      label: k.label,
      secret: k.secret,
      optional: k.optional ?? false,
    })),
    knownModels: d.knownModels,
  }));
}

function envRecord(): Record<string, string | undefined> {
  return { ...process.env };
}

function modelLabel(providerId: ProviderId, modelId: string, customLabel?: string): string {
  if (customLabel) return customLabel;
  const known = getProviderDefinition(providerId).knownModels.find((m) => m.id === modelId);
  return known?.label ?? modelId;
}

function toConfiguredModels(
  providerId: ProviderId,
  cfg: VoiceProviderConfig | undefined,
): ConfiguredModel[] {
  if (!cfg) return [];
  return cfg.models.map((m) => ({
    id: m.id,
    label: modelLabel(providerId, m.id, m.label),
    builtin: m.builtin,
  }));
}

export function getVoiceProvidersView(): VoiceProvidersResponse {
  const { settings } = getConfig();
  const voice = settings.voice;
  const envSnap = envRecord();

  const providers: ProviderView[] = PROVIDER_DEFINITIONS.map((def) => {
    const cfg = voice.providers[def.id];
    const registered = Boolean(cfg);
    const viable = isProviderViable(def.id, envSnap);

    return {
      id: def.id,
      displayName: def.displayName,
      description: def.description,
      registered,
      viable,
      isDefault: voice.defaultProvider === def.id,
      defaultModel: cfg?.defaultModel ?? null,
      models: toConfiguredModels(def.id, cfg),
      keyStatus: getProviderKeyStatus(def.id, envSnap),
    };
  });

  const availableToRegister = providers
    .filter((p) => p.viable && !p.registered)
    .map((p) => p.id);

  return {
    defaultProvider: voice.defaultProvider,
    wakeWords: voice.wakeWords,
    turnSubmit: voice.turnSubmit,
    catalog: getCatalog(),
    providers,
    availableToRegister,
  };
}

function persistVoiceUpdate(
  mutate: (voice: VoiceSettingsInput) => void,
  auditReason: string,
): VoiceSettings {
  const file = readConfigFile();
  mutate(file.settings.voice);
  writeConfigFile(file);
  reloadConfig();
  resetVoiceProvider();
  writeAudit({ tool: 'voice_provider_config', result: 'ok', reason: auditReason });
  log.info({ reason: auditReason }, 'voice config updated');
  return getConfig().settings.voice;
}

function defaultProviderConfig(id: ProviderId): VoiceProviderConfig {
  const def = getProviderDefinition(id);
  const defaultModel = def.knownModels[0]?.id;
  if (!defaultModel) throw new Error(`Provider ${id} has no known models`);
  return {
    defaultModel,
    models: def.knownModels.map((m) => ({
      id: m.id,
      label: m.label,
      builtin: true,
    })),
  };
}

export function registerProvider(id: string): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);
  if (!isProviderViable(id, envRecord())) {
    throw new Error(`Provider "${id}" is not viable — configure env keys first`);
  }

  persistVoiceUpdate((voice) => {
    if (!voice.providers[id]) {
      voice.providers[id] = defaultProviderConfig(id);
    }
    if (!voice.providers[voice.defaultProvider]) {
      voice.defaultProvider = id;
    }
  }, `register ${id}`);

  return getVoiceProvidersView();
}

export function unregisterProvider(id: string): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);

  persistVoiceUpdate((voice) => {
    if (!voice.providers[id]) throw new Error(`Provider "${id}" is not registered`);
    delete voice.providers[id];

    if (voice.defaultProvider === id) {
      const remaining = Object.keys(voice.providers) as ProviderId[];
      if (remaining.length === 0) {
        throw new Error('Cannot remove the last registered provider');
      }
      voice.defaultProvider = remaining[0]!;
    }
  }, `unregister ${id}`);

  return getVoiceProvidersView();
}

export function setDefaultProvider(id: string): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);

  persistVoiceUpdate((voice) => {
    if (!voice.providers[id]) throw new Error(`Provider "${id}" is not registered`);
    if (!isProviderViable(id, envRecord())) {
      throw new Error(`Provider "${id}" is not viable — check env keys`);
    }
    voice.defaultProvider = id;
  }, `default provider → ${id}`);

  return getVoiceProvidersView();
}

export function setProviderDefaultModel(id: string, modelId: string): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);

  persistVoiceUpdate((voice) => {
    const cfg = voice.providers[id];
    if (!cfg) throw new Error(`Provider "${id}" is not registered`);
    if (!cfg.models.some((m) => m.id === modelId)) {
      throw new Error(`Model "${modelId}" is not in provider "${id}" model list`);
    }
    cfg.defaultModel = modelId;
  }, `${id} default model → ${modelId}`);

  return getVoiceProvidersView();
}

const AddModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
});

export function addProviderModel(id: string, raw: unknown): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);
  const parsed = AddModelSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.message);

  const { id: modelId, label } = parsed.data;

  persistVoiceUpdate((voice) => {
    const cfg = voice.providers[id];
    if (!cfg) throw new Error(`Provider "${id}" is not registered`);
    if (cfg.models.some((m) => m.id === modelId)) {
      throw new Error(`Model "${modelId}" already exists`);
    }
    cfg.models.push({ id: modelId, label, builtin: false });
  }, `${id} add model ${modelId}`);

  return getVoiceProvidersView();
}

export function removeProviderModel(id: string, modelId: string): VoiceProvidersResponse {
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${id}`);

  persistVoiceUpdate((voice) => {
    const cfg = voice.providers[id];
    if (!cfg) throw new Error(`Provider "${id}" is not registered`);
    const idx = cfg.models.findIndex((m) => m.id === modelId);
    if (idx < 0) throw new Error(`Model "${modelId}" not found`);

    cfg.models.splice(idx, 1);
    if (cfg.models.length === 0) {
      throw new Error('Cannot remove the last model — unregister the provider instead');
    }
    if (cfg.defaultModel === modelId) {
      cfg.defaultModel = cfg.models[0]!.id;
    }
  }, `${id} remove model ${modelId}`);

  return getVoiceProvidersView();
}

const WakeWordsBodySchema = z.object({
  start: z.string().min(1).max(100),
  end: z.string().max(100).optional(),
  silenceMs: z.number().int().min(500).max(30_000).optional(),
});

export function setWakeWords(raw: unknown): VoiceProvidersResponse {
  const parsed = WakeWordsBodySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid wake phrase — start is required');

  const startTrim = parsed.data.start.trim();
  const endTrim = parsed.data.end?.trim();
  if (!startTrim) throw new Error('Activation phrase cannot be empty');

  persistVoiceUpdate((voice) => {
    voice.wakeWords = {
      start: startTrim,
      end: parsed.data.end !== undefined ? endTrim ?? '' : (voice.wakeWords.end ?? 'send'),
    };
    if (parsed.data.silenceMs !== undefined) {
      voice.turnSubmit = { silenceMs: parsed.data.silenceMs };
    }
  }, `wake phrase → start="${startTrim}" end="${endTrim ?? '(unchanged)'}"`);

  return getVoiceProvidersView();
}

export function resolveActiveVoiceProvider(): { providerId: ProviderId; model: string } {
  const { settings } = getConfig();
  const voice = settings.voice;
  const providerId = voice.defaultProvider;
  const cfg = voice.providers[providerId];

  if (!cfg) {
    throw new Error(
      `Default voice provider "${providerId}" is not registered. Add it in Settings.`,
    );
  }
  if (!isProviderViable(providerId, envRecord())) {
    throw new Error(`Default voice provider "${providerId}" is not viable — check .env keys.`);
  }

  return { providerId, model: cfg.defaultModel };
}
