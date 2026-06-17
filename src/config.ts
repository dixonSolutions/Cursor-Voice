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
import { resolve } from 'node:path';
import {
  PROVIDER_IDS,
  getProviderDefinition,
  type ProviderId,
} from './realtime/provider_keys.js';
import {
  DEFAULT_LLM_INTELLIGENCE_PROMPTS,
  DEFAULT_SYSTEM_PROMPTS,
  loadVoiceSystemPrompt,
  loadWorkflowSystemPrompt,
} from './state/promptLoader.js';
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
  end: z.string().max(100).default('send'),
});

export const TurnSubmitSchema = z.object({
  /** Ms of silence after last STT final before auto-submitting the buffered turn. */
  silenceMs: z.number().int().min(500).max(30_000).default(1500),
});

/** Resolved voice system prompt (loaded from prompts/ at startup). */
export const VoiceSystemPromptSchema = z.object({
  /** Template with {{ACTIVATION_RULES}}, {{PROJECT_CATALOG}}, {{WAKE_START}}. */
  template: z.string().min(1).max(65_536),
  /** Activation block with {{WAKE_START}}; injected into {{ACTIVATION_RULES}}. */
  activationRules: z.string().min(1).max(16_384),
});

export const VoiceSettingsSchema = z.object({
  defaultProvider: z.enum(PROVIDER_IDS),
  providers: z.record(z.enum(PROVIDER_IDS), VoiceProviderConfigSchema),
  wakeWords: WakeWordsSchema,
  turnSubmit: TurnSubmitSchema.default({}),
  /** Paths to prompt manifests, relative to config.json (see prompts/systemprompts.json). */
  systemPrompts: z.array(z.string().min(1)).min(1).default(['prompts/systemprompts.json']),
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

// ── Workflow config (llm_intelligence vs s2s_voice) ───────────────────────────

export const WORKFLOW_IDS = ['cursor_native', 'llm_intelligence', 's2s_voice'] as const;
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
  /** Paths relative to config.json — see prompts/llm-intelligence/. */
  systemPrompts: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULT_LLM_INTELLIGENCE_PROMPTS]),
  memory: LlmIntelligenceMemorySchema.default({}),
  /** Max chars returned to Claude from read_output / status payloads. */
  readOutputMaxChars: z.number().int().min(1000).max(32_768).default(8000),
});

export const S2sVoiceWorkflowSchema = z.object({
  systemPrompts: z.array(z.string().min(1)).min(1).default(['prompts/systemprompts.json']),
});

export const WorkflowSettingsSchema = z.object({
  /** Active voice pipeline — cursor_native (default), llm_intelligence, or legacy s2s_voice. */
  default: z.enum(WORKFLOW_IDS).default('cursor_native'),
  llmIntelligence: LlmIntelligenceWorkflowSchema.default({}),
  s2sVoice: S2sVoiceWorkflowSchema.default({}),
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
export type TurnSubmit = z.infer<typeof TurnSubmitSchema>;
export type VoiceSystemPrompt = z.infer<typeof VoiceSystemPromptSchema>;
export type VoiceProviderConfig = z.infer<typeof VoiceProviderConfigSchema>;
export type VoiceSettingsInput = z.infer<typeof VoiceSettingsSchema>;
export type VoiceSettings = VoiceSettingsInput & {
  /** Populated at load time from systemPrompts manifests — not stored in config.json. */
  systemPrompt: VoiceSystemPrompt;
};
export type RunModes = z.infer<typeof RunModesSchema>;
export type LlmIntelligenceWorkflow = z.infer<typeof LlmIntelligenceWorkflowSchema>;
export type S2sVoiceWorkflow = z.infer<typeof S2sVoiceWorkflowSchema>;
export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema> & {
  llmIntelligence: LlmIntelligenceWorkflow & {
    systemPrompt: VoiceSystemPrompt;
  };
};
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
    if (typeof voice['wakeWords'] === 'object' && voice['wakeWords'] !== null) {
      const ww = voice['wakeWords'] as Record<string, unknown>;
      delete ww['stop'];
      if (typeof ww['end'] !== 'string' || !String(ww['end']).trim()) {
        ww['end'] = 'send';
      }
    }
    if (!voice['turnSubmit'] || typeof voice['turnSubmit'] !== 'object') {
      voice['turnSubmit'] = { silenceMs: 1500 };
    }
    if (!voice['wakeWords'] || typeof voice['wakeWords'] !== 'object') {
      throw new Error(
        'config.json must include settings.voice.wakeWords.start — see config.example.json',
      );
    }
    if ('systemPrompt' in voice) {
      delete voice['systemPrompt'];
      log.info('Migrated legacy inline settings.voice.systemPrompt → settings.voice.systemPrompts');
    }
    if (!voice['systemPrompts']) {
      voice['systemPrompts'] = [...DEFAULT_SYSTEM_PROMPTS];
    }
    const settingsObj = s;
    if (!settingsObj['workflow']) {
      settingsObj['workflow'] = { default: 'cursor_native' };
      log.info('Migrated config — added default workflow cursor_native');
    }
    return raw;
  }

  throw new Error(
    'Missing settings.voice in config.json — see config.example.json (include wakeWords.start).',
  );
}

function resolveVoiceSettings(configPath: string, voice: VoiceSettingsInput): VoiceSettings {
  return {
    ...voice,
    systemPrompt: loadVoiceSystemPrompt(configPath, voice.systemPrompts),
  };
}

function resolveWorkflowSettings(
  configPath: string,
  workflow: z.infer<typeof WorkflowSettingsSchema>,
): WorkflowSettings {
  const llmIntelligenceRaw = workflow.llmIntelligence;
  const audioRegion = llmIntelligenceRaw.audio.region ?? llmIntelligenceRaw.llm.region;
  const llmIntelligence = {
    ...llmIntelligenceRaw,
    audio: { ...llmIntelligenceRaw.audio, region: audioRegion },
    systemPrompt: loadWorkflowSystemPrompt(
      configPath,
      llmIntelligenceRaw.systemPrompts,
    ),
  };
  return { ...workflow, llmIntelligence };
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

  const voice = resolveVoiceSettings(configPath, configFile.settings.voice);
  const workflow = resolveWorkflowSettings(configPath, configFile.settings.workflow);

  return {
    env,
    settings: {
      ...configFile.settings,
      voice,
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
      defaultVoiceProvider: _config.settings.voice.defaultProvider,
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
