/**
 * Configuration loader — single source of truth for all settings.
 *
 * Split by sensitivity:
 *   .env        → secrets + machine-specific bootstrap paths (never committed)
 *   config.json → operational settings + project registry (non-secret)
 *
 * Precedence: .env > config.json > built-in defaults.
 * Both files are zod-validated at startup; invalid config fails fast.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { childLogger } from './log.js';

const log = childLogger('config');

// ── .env schema (secrets + bootstrap) ────────────────────────────────────────

const EnvSchema = z.object({
  APP_TOKEN: z
    .string()
    .min(16, 'APP_TOKEN must be at least 16 characters — generate with: openssl rand -base64 32'),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  CONFIG_PATH: z.string().default('./config.json'),
  DB_PATH: z.string().default('./data/state.db'),
});

// ── config.json schema ────────────────────────────────────────────────────────

const SettingsSchema = z.object({
  voiceProvider: z.enum(['openai', 'gemini']).default('openai'),
  realtimeModel: z.string().default('gpt-realtime'),
  defaultMode: z.enum(['agent', 'plan']).default('agent'),
  maxConcurrentJobs: z.number().int().min(1).max(4).default(1),
  jobTimeoutMs: z.number().int().positive().default(600_000),
  planFirst: z.boolean().default(false),
  // Pre-run flags applied to every cursor-agent invocation. Order matters.
  preRunFlags: z.array(z.string()).default(['--force', '--trust']),
  modelCacheTtlMs: z.number().int().positive().default(3_600_000),
  narratorEnabled: z.boolean().default(true),
  narratorCadenceMs: z.number().int().positive().default(15_000),
  narratorMaxBufferEvents: z.number().int().positive().default(50),
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

const ConfigFileSchema = z.object({
  settings: SettingsSchema,
  projects: z.array(ProjectConfigSchema).min(1, 'At least one project must be registered'),
});

// ── Exported types ────────────────────────────────────────────────────────────

export type AppEnv = z.infer<typeof EnvSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface AppConfig {
  env: AppEnv;
  settings: Settings;
  projects: ProjectConfig[];
}

// ── Loader (singleton) ────────────────────────────────────────────────────────

let _config: AppConfig | null = null;

/**
 * Load and validate configuration from the environment and config.json.
 * Called once at startup; subsequent calls return the cached result.
 */
export function loadConfig(): AppConfig {
  if (_config) return _config;

  // 1. Validate environment (dotenv already loaded by index.ts)
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    throw new Error(`Invalid environment variables:\n${envResult.error.message}`);
  }
  const env = envResult.data;

  // 2. Load and validate config.json
  const configPath = resolve(env.CONFIG_PATH);
  if (!existsSync(configPath)) {
    throw new Error(
      `config.json not found at ${configPath}.\n` +
        'Copy config.example.json to config.json and edit it.',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read ${configPath}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${String(err)}`);
  }

  const cfgResult = ConfigFileSchema.safeParse(parsed);
  if (!cfgResult.success) {
    throw new Error(`Invalid config.json:\n${cfgResult.error.message}`);
  }
  const configFile = cfgResult.data;

  _config = {
    env,
    settings: configFile.settings,
    projects: configFile.projects,
  };

  log.info(
    {
      configPath,
      projectCount: _config.projects.length,
      voiceProvider: _config.settings.voiceProvider,
      logLevel: _config.settings.logLevel,
    },
    'config loaded',
  );

  return _config;
}

/** Return the singleton config, throwing if loadConfig() has not been called. */
export function getConfig(): AppConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
