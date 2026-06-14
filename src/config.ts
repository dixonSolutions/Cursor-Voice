/**
 * Configuration loader — single source of truth for all settings.
 *
 * Split by sensitivity:
 *   .env        → secrets + machine-specific bootstrap paths (never committed)
 *   config.json → operational settings + project registry (non-secret)
 *
 * Voice providers:
 *   .env determines which providers are *viable* (keys present + valid).
 *   config.json stores registered providers, model lists, and defaults.
 *   See docs/13-voice-providers.md and provider_keys.ts.
 *
 * Precedence: .env > config.json > built-in defaults.
 * Both files are zod-validated at startup; invalid config fails fast.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_IDS,
  getProviderDefinition,
  type ProviderId,
} from './realtime/provider_keys.js';
import { DEFAULT_WAKE_WORDS } from './realtime/wakeWords.js';
import { childLogger } from './log.js';

const log = childLogger('config');

// ── .env schema (secrets + bootstrap) ────────────────────────────────────────

const EnvSchema = z.object({
  APP_TOKEN: z
    .string()
    .min(16, 'APP_TOKEN must be at least 16 characters — generate with: openssl rand -base64 32'),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_REGION: z.string().optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  CONFIG_PATH: z.string().default('./config.json'),
  DB_PATH: z.string().default('./data/state.db'),
});

// ── Voice provider config (config.json) ─────────────────────────────────────

const VoiceModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  builtin: z.boolean().default(false),
});

export const VoiceProviderConfigSchema = z.object({
  defaultModel: z.string().min(1),
  models: z.array(VoiceModelSchema).min(1),
});

export const WakeWordsSchema = z.object({
  start: z.string().min(1).max(100),
  stop: z.string().min(1).max(100),
});

/** Voice model system prompt — editable in config.json (not hardcoded in session.ts). */
export const VoiceSystemPromptSchema = z.object({
  /** Template with {{ACTIVATION_RULES}}, {{PROJECT_CATALOG}}, {{WAKE_START}}, {{WAKE_STOP}}. */
  template: z.string().min(1).max(65_536),
  /** Activation block with {{WAKE_START}} / {{WAKE_STOP}}; injected into {{ACTIVATION_RULES}}. */
  activationRules: z.string().min(1).max(16_384),
});

export const VoiceSettingsSchema = z.object({
  defaultProvider: z.enum(PROVIDER_IDS),
  providers: z.record(z.enum(PROVIDER_IDS), VoiceProviderConfigSchema),
  wakeWords: WakeWordsSchema.default(DEFAULT_WAKE_WORDS),
  systemPrompt: VoiceSystemPromptSchema,
});

// ── Run mode (test vs serve) ────────────────────────────────────────────────

export const RUN_MODES = ['test', 'serve'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const TestRunModeSchema = z.object({
  backendPort: z.number().int().min(1024).max(65535).default(8000),
  webPort: z.number().int().min(1024).max(65535).default(4200),
});

const ServeRunModeSchema = z.object({
  backendPort: z.number().int().min(1024).max(65535).default(8787),
  /** Public HTTPS origin (e.g. Tailscale serve URL). Shown in healthz / setup hints. */
  publicBaseUrl: z.string().url().optional(),
});

const RunModesSchema = z.object({
  test: TestRunModeSchema.default({}),
  serve: ServeRunModeSchema.default({}),
});

// ── config.json schema ───────────────────────────────────────────────────────

const SettingsSchema = z.object({
  /** `test` = localhost dev (backend + ng serve). `serve` = production / Tailscale. */
  runMode: z.enum(RUN_MODES).default('test'),
  runModes: RunModesSchema.default({}),
  voice: VoiceSettingsSchema,
  defaultMode: z.enum(['agent', 'plan']).default('agent'),
  maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
  jobTimeoutMs: z.number().int().positive().default(600_000),
  planFirst: z.boolean().default(false),
  preRunFlags: z.array(z.string()).default(['--force', '--trust']),
  modelCacheTtlMs: z.number().int().positive().default(3_600_000),
  narratorEnabled: z.boolean().default(true),
  narratorCadenceMs: z.number().int().positive().default(15_000),
  narratorMaxBufferEvents: z.number().int().positive().default(50),
  /** Kill cursor-agent immediately if it tries to spawn Task/subagent sessions. */
  ghostKillEnabled: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const ProjectConfigSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9_-]+$/,
      'Project name must be slug-safe (lowercase a–z, 0–9, hyphens, underscores)',
    ),
  path: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const ConfigFileSchema = z.object({
  settings: SettingsSchema,
  projects: z.array(ProjectConfigSchema).min(1, 'At least one project must be registered'),
});

// ── Legacy schema (migration from voiceProvider + realtimeModel) ─────────────

const LegacySettingsSchema = z
  .object({
    voiceProvider: z.enum(['openai', 'gemini']).optional(),
    realtimeModel: z.string().optional(),
  })
  .passthrough();

// ── Exported types ────────────────────────────────────────────────────────────

export type AppEnv = z.infer<typeof EnvSchema>;
export type VoiceModel = z.infer<typeof VoiceModelSchema>;
export type WakeWords = z.infer<typeof WakeWordsSchema>;
export type VoiceSystemPrompt = z.infer<typeof VoiceSystemPromptSchema>;
export type VoiceProviderConfig = z.infer<typeof VoiceProviderConfigSchema>;
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;
export type RunModes = z.infer<typeof RunModesSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface AppConfig {
  env: AppEnv;
  settings: Settings;
  projects: ProjectConfig[];
}

// ── Voice prompt defaults (config/voice-system-prompt.json — not in session.ts) ─

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const VOICE_PROMPT_DEFAULTS_PATH = join(_moduleDir, '..', 'config', 'voice-system-prompt.json');

export function loadDefaultVoiceSystemPrompt(): VoiceSystemPrompt {
  if (!existsSync(VOICE_PROMPT_DEFAULTS_PATH)) {
    throw new Error(
      `Missing ${VOICE_PROMPT_DEFAULTS_PATH} — required for voice systemPrompt defaults`,
    );
  }
  const raw = JSON.parse(readFileSync(VOICE_PROMPT_DEFAULTS_PATH, 'utf-8')) as unknown;
  return VoiceSystemPromptSchema.parse(raw);
}

// ── Migration ─────────────────────────────────────────────────────────────────

function seedProviderConfig(id: ProviderId, defaultModel?: string): VoiceProviderConfig {
  const def = getProviderDefinition(id);
  const model = defaultModel ?? def.knownModels[0]?.id ?? 'unknown';
  return {
    defaultModel: model,
    models: def.knownModels.map((m) => ({
      id: m.id,
      label: m.label,
      builtin: true,
    })),
  };
}

function migrateRawConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const settings = obj['settings'];
  if (typeof settings !== 'object' || settings === null) return raw;

  const s = settings as Record<string, unknown>;
  if ('voice' in s && s['voice'] !== undefined) {
    const voice = s['voice'] as Record<string, unknown>;
    if (!voice['wakeWords']) {
      voice['wakeWords'] = { ...DEFAULT_WAKE_WORDS };
    }
    if (!voice['systemPrompt']) {
      voice['systemPrompt'] = loadDefaultVoiceSystemPrompt();
    }
    return raw;
  }

  const legacy = LegacySettingsSchema.safeParse(s);
  const legacyProvider = legacy.success ? legacy.data.voiceProvider : undefined;
  const legacyModel = legacy.success ? legacy.data.realtimeModel : undefined;

  const providerId: ProviderId =
    legacyProvider === 'gemini' ? 'gemini' : 'openai';

  const voice: VoiceSettings = {
    defaultProvider: providerId,
    providers: {
      [providerId]: seedProviderConfig(providerId, legacyModel),
    },
    wakeWords: { ...DEFAULT_WAKE_WORDS },
    systemPrompt: loadDefaultVoiceSystemPrompt(),
  };

  const { voiceProvider: _vp, realtimeModel: _rm, ...rest } = s;
  void _vp;
  void _rm;
  return {
    ...obj,
    settings: {
      ...rest,
      voice,
    },
  };
}

function defaultVoiceSettings(): VoiceSettings {
  return {
    defaultProvider: 'openai',
    providers: {
      openai: seedProviderConfig('openai'),
    },
    wakeWords: { ...DEFAULT_WAKE_WORDS },
    systemPrompt: loadDefaultVoiceSystemPrompt(),
  };
}

// ── Loader (singleton) ────────────────────────────────────────────────────────

let _config: AppConfig | null = null;
let _configPath = './config.json';

export function getConfigPath(): string {
  return _configPath;
}

function loadFromDisk(): AppConfig {
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    throw new Error(`Invalid environment variables:\n${envResult.error.message}`);
  }
  const env = envResult.data;
  _configPath = env.CONFIG_PATH;

  const configPath = resolve(env.CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new Error(
      `config.json not found at ${configPath}.\n` +
        'Copy config.example.json to config.json and edit it.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${String(err)}`);
  }

  parsed = migrateRawConfig(parsed);

  const cfgResult = ConfigFileSchema.safeParse(parsed);
  if (!cfgResult.success) {
    throw new Error(`Invalid config.json:\n${cfgResult.error.message}`);
  }

  const configFile = cfgResult.data;

  if (!configFile.settings.voice) {
    configFile.settings.voice = defaultVoiceSettings();
  }

  return {
    env,
    settings: configFile.settings,
    projects: configFile.projects,
  };
}

export function loadConfig(): AppConfig {
  if (_config) return _config;
  _config = loadFromDisk();

  log.info(
    {
      configPath: resolve(_configPath),
      projectCount: _config.projects.length,
      runMode: _config.settings.runMode,
      defaultVoiceProvider: _config.settings.voice.defaultProvider,
      logLevel: _config.settings.logLevel,
    },
    'config loaded',
  );

  return _config;
}

/** Reload config from disk (after config.json or .env key updates). */
export function reloadConfig(): AppConfig {
  _config = loadFromDisk();
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
