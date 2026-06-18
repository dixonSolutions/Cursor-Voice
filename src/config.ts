/**
 * Configuration loader — single source of truth for all settings.
 *
 * Split by sensitivity:
 *   .env        → secrets + machine-specific bootstrap paths (never committed)
 *   config.json → operational settings + project registry (non-secret)
 *
 * Voice settings (wake words, turn submit) live in config.json.
 * AWS IAM keys in .env power Polly, Transcribe, and Bedrock Converse.
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
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_REGION: z.string().optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  CONFIG_PATH: z.string().default('./config.json'),
  DB_PATH: z.string().default('./data/state.db'),
});

// ── Voice settings (config.json) ─────────────────────────────────────────────

export const WakeWordsSchema = z.object({
  start: z.string().min(1).max(100),
  end: z.string().max(100).default('send'),
  /** Spoken during capture to abort the turn without sending — default "cancel". */
  cancel: z.string().max(100).default('cancel'),
});

export const TurnSubmitSchema = z.object({
  /** Ms of silence after last STT final before auto-submitting the buffered turn. */
  silenceMs: z.number().int().min(500).max(30_000).default(1500),
  /** When true, Silero VAD detects speech end; when false, use end wake phrase or silence timer. */
  vadEnabled: z.boolean().default(true),
});

export const VoiceSettingsSchema = z.object({
  wakeWords: WakeWordsSchema,
  turnSubmit: TurnSubmitSchema.default({}),
});

// ── Run mode (test vs serve) ────────────────────────────────────────────────

export const RUN_MODES = ['test', 'serve'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const TestRunModeSchema = z.object({
  backendPort: z.number().int().min(1024).max(65535).default(3000),
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

// ── Workflow config ───────────────────────────────────────────────────────────

export const WORKFLOW_IDS = ['cursor_native', 'llm_intelligence'] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

const LlmIntelligenceMemorySchema = z.object({
  maxTurns: z.number().int().min(4).max(40).default(10),
  keepTurns: z.number().int().min(2).max(20).default(4),
  summarySentences: z.number().int().min(1).max(6).default(3),
});

const LlmIntelligenceLlmSchema = z.object({
  provider: z.enum(['bedrock']).default('bedrock'),
  model: z.string().min(1).default('us.anthropic.claude-sonnet-4-20250514-v1:0'),
  region: z.string().min(1).default('us-east-1'),
  maxTokens: z.number().int().min(256).max(8192).default(4096),
});

const LlmIntelligenceAudioSchema = z.object({
  /** Try WebKit STT/TTS first (iPhone); fall back to Amazon when unavailable. */
  preferWebkit: z.boolean().default(true),
  /** AWS region for Polly + Transcribe (defaults to llm.region if omitted at runtime). */
  region: z.string().min(1).optional(),
  pollyVoiceId: z.string().min(1).default('Joanna'),
  pollyEngine: z.enum(['standard', 'neural', 'generative']).default('neural'),
  transcribeLanguageCode: z.string().min(2).default('en-US'),
});

export const LlmIntelligenceWorkflowSchema = z.object({
  llm: LlmIntelligenceLlmSchema.default({}),
  audio: LlmIntelligenceAudioSchema.default({}),
  memory: LlmIntelligenceMemorySchema.default({}),
  /** Max chars returned to Claude from read_output / status payloads. */
  readOutputMaxChars: z.number().int().min(1000).max(32_768).default(8000),
});

export const WorkflowSettingsSchema = z.object({
  /** Active voice pipeline — cursor_native (default) or llm_intelligence. */
  default: z.enum(WORKFLOW_IDS).default('cursor_native'),
  llmIntelligence: LlmIntelligenceWorkflowSchema.default({}),
});

// ── config.json schema ───────────────────────────────────────────────────────

const SettingsSchema = z.object({
  /** `test` = localhost dev (backend + ng serve). `serve` = production / Tailscale. */
  runMode: z.enum(RUN_MODES).default('test'),
  runModes: RunModesSchema.default({}),
  /** Voice pipeline selection and per-workflow settings. See docs/15-llm-intelligence-workflow.md. */
  workflow: WorkflowSettingsSchema.default({}),
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

// ── Exported types ────────────────────────────────────────────────────────────

export type AppEnv = z.infer<typeof EnvSchema>;
export type WakeWords = z.infer<typeof WakeWordsSchema>;
export type TurnSubmit = z.infer<typeof TurnSubmitSchema>;
export type VoiceSettingsInput = z.infer<typeof VoiceSettingsSchema>;
export type VoiceSettings = VoiceSettingsInput;
export type RunModes = z.infer<typeof RunModesSchema>;
export type LlmIntelligenceWorkflow = z.infer<typeof LlmIntelligenceWorkflowSchema>;
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;
export type Settings = Omit<z.infer<typeof SettingsSchema>, 'voice' | 'workflow'> & {
  voice: VoiceSettings;
  workflow: WorkflowSettings;
};
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface AppConfig {
  env: AppEnv;
  settings: Settings;
  projects: ProjectConfig[];
}

// ── Migration ─────────────────────────────────────────────────────────────────

function migrateRawConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const settings = obj['settings'];
  if (typeof settings !== 'object' || settings === null) return raw;

  const s = settings as Record<string, unknown>;

  if ('voice' in s && s['voice'] !== undefined) {
    const voice = s['voice'] as Record<string, unknown>;
    if (typeof voice['wakeWords'] === 'object' && voice['wakeWords'] !== null) {
      const ww = voice['wakeWords'] as Record<string, unknown>;
      delete ww['stop'];
      if (typeof ww['end'] !== 'string' || !String(ww['end']).trim()) {
        ww['end'] = 'send';
      }
    }
    if (!voice['turnSubmit'] || typeof voice['turnSubmit'] !== 'object') {
      voice['turnSubmit'] = { silenceMs: 1500, vadEnabled: true };
    } else {
      const ts = voice['turnSubmit'] as Record<string, unknown>;
      if (ts['vadEnabled'] === undefined) ts['vadEnabled'] = true;
    }
    if (!voice['wakeWords'] || typeof voice['wakeWords'] !== 'object') {
      throw new Error(
        'config.json must include settings.voice.wakeWords.start — see config.example.json',
      );
    }

    // Strip legacy S2S voice provider fields.
    delete voice['defaultProvider'];
    delete voice['providers'];
    delete voice['systemPrompts'];
    delete voice['systemPrompt'];

    if (!s['workflow']) {
      s['workflow'] = { default: 'cursor_native' };
      log.info('Migrated config — added default workflow cursor_native');
    } else if (typeof s['workflow'] === 'object' && s['workflow'] !== null) {
      const wf = s['workflow'] as Record<string, unknown>;
      if (wf['default'] === 's2s_voice') {
        wf['default'] = 'cursor_native';
        log.info('Migrated workflow default s2s_voice → cursor_native');
      }
      delete wf['s2sVoice'];
      if (typeof wf['llmIntelligence'] === 'object' && wf['llmIntelligence'] !== null) {
        delete (wf['llmIntelligence'] as Record<string, unknown>)['systemPrompts'];
      }
    }

    return raw;
  }

  throw new Error(
    'Missing settings.voice in config.json — see config.example.json (include wakeWords.start).',
  );
}

function resolveWorkflowSettings(
  workflow: z.infer<typeof WorkflowSettingsSchema>,
): WorkflowSettings {
  const llmIntelligenceRaw = workflow.llmIntelligence;
  const audioRegion = llmIntelligenceRaw.audio.region ?? llmIntelligenceRaw.llm.region;
  return {
    ...workflow,
    llmIntelligence: {
      ...llmIntelligenceRaw,
      audio: { ...llmIntelligenceRaw.audio, region: audioRegion },
    },
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
  const workflow = resolveWorkflowSettings(configFile.settings.workflow);

  return {
    env,
    settings: {
      ...configFile.settings,
      voice: configFile.settings.voice,
      workflow,
    },
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
      defaultWorkflow: _config.settings.workflow.default,
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
