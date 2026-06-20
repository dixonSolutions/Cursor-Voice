/**
 * TypeScript types for the admin settings API responses.
 * Mirror the backend Zod schemas and route return shapes.
 */

// ── Workflow ───────────────────────────────────────────────────────────────

export interface LlmSettings {
  model: string;
  region: string;
  maxTokens: number;
}

export interface AudioSettings {
  preferWebkit: boolean;
  region?: string;
  pollyVoiceId: string;
  pollyEngine: 'standard' | 'neural' | 'generative';
  transcribeLanguageCode: string;
}

export interface MemorySettings {
  maxTurns: number;
  keepTurns: number;
  summarySentences: number;
}

export interface LlmIntelligenceSettings {
  llm: LlmSettings;
  audio: AudioSettings;
  memory: MemorySettings;
  readOutputMaxChars: number;
}

export type WorkflowDefault = 'cursor_native' | 'llm_intelligence';

export interface WorkflowSettings {
  default: WorkflowDefault;
  llmIntelligence: LlmIntelligenceSettings;
}

// ── Hosting ────────────────────────────────────────────────────────────────

export type RunMode = 'test' | 'serve';

export interface TestModeSettings {
  backendPort: number;
  webPort: number;
}

export interface ServeModeSettings {
  backendPort: number;
  publicBaseUrl?: string;
}

export interface RunModes {
  test: TestModeSettings;
  serve: ServeModeSettings;
}

export interface HostingSettings {
  runMode: RunMode;
  runModes: RunModes;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type DefaultMode = 'agent' | 'plan';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface JobSettings {
  defaultMode: DefaultMode;
  maxConcurrentJobs: number;
  jobTimeoutMs: number;
  planFirst: boolean;
  preRunFlags: string[];
  modelCacheTtlMs: number;
  ghostKillEnabled: boolean;
  logLevel: LogLevel;
}

// ── Narrator ───────────────────────────────────────────────────────────────

export interface NarratorSettings {
  narratorEnabled: boolean;
  narratorCadenceMs: number;
  narratorMaxBufferEvents: number;
}

// ── AWS Keys ───────────────────────────────────────────────────────────────

export interface AwsKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  configured: boolean;
  complete: boolean;
}

export interface KeysStatus {
  keys: AwsKeyStatus[];
  viable: boolean;
  configured: boolean;
}

export interface KeysTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

// ── Projects (admin) ───────────────────────────────────────────────────────

export interface AdminProject {
  name: string;
  path: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
  resumeId: string | null;
  model: string | null;
  pathExists: boolean;
  updatedAt: string;
}

// ── Database ───────────────────────────────────────────────────────────────

export interface DbStats {
  counts: Record<string, number>;
  sizeBytes: number;
  dbPath: string;
}

export interface AuditEntry {
  id: number;
  tool: string;
  result: string;
  reason: string | null;
  created_at: string;
}
