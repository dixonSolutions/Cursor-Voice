/** Voice provider types — mirrors GET /api/voice/providers (no secrets). */

export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'amazon_bedrock';

export interface EnvKeyStatus {
  envVar: string;
  label: string;
  secret: boolean;
  optional: boolean;
  configured: boolean;
  complete: boolean;
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
  keyStatus: EnvKeyStatus[];
}

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
  knownModels: Array<{ id: string; label: string; description?: string }>;
}

export interface WakeWords {
  start: string;
  end: string;
}

export interface TurnSubmit {
  silenceMs: number;
  vadEnabled?: boolean;
}

export interface VoiceProvidersResponse {
  defaultProvider: ProviderId;
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  catalog: CatalogProvider[];
  providers: ProviderView[];
  availableToRegister: ProviderId[];
}
