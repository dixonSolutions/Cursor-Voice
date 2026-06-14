/**
 * Voice provider catalog — env key schemas and known speech-to-speech models.
 *
 * Cost tiers (approximate, for planning — verify current pricing):
 *   $   = lowest cost / good for always-on PTT
 *   $$  = balanced quality and cost
 *   $$$ = highest quality, higher latency cost
 *
 * See docs/13-voice-providers.md.
 */

export const PROVIDER_IDS = ['openai', 'gemini', 'anthropic', 'amazon_bedrock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface EnvKeyField {
  envVar: string;
  label: string;
  minLength: number;
  secret: boolean;
  optional?: boolean;
}

export interface KnownModel {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  description: string;
  envKeys: EnvKeyField[];
  knownModels: KnownModel[];
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    description: 'OpenAI Realtime API — native WebRTC speech-to-speech',
    envKeys: [
      { envVar: 'OPENAI_API_KEY', label: 'API Key', minLength: 20, secret: true },
    ],
    knownModels: [
      {
        id: 'gpt-realtime-mini',
        label: 'GPT Realtime Mini',
        description: '$ Best cost/performance — recommended default for PTT',
      },
      {
        id: 'gpt-4o-mini-realtime-preview',
        label: 'GPT-4o Mini Realtime',
        description: '$ Preview mini realtime — low cost, good tool calling',
      },
      {
        id: 'gpt-realtime',
        label: 'GPT Realtime',
        description: '$$ GA full model — best instruction following',
      },
      {
        id: 'gpt-4o-realtime-preview',
        label: 'GPT-4o Realtime Preview',
        description: '$$ Higher quality preview — use when mini is not enough',
      },
    ],
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    description: 'Gemini Live — native audio (Polish + English)',
    envKeys: [
      { envVar: 'GEMINI_API_KEY', label: 'API Key', minLength: 20, secret: true },
    ],
    knownModels: [
      {
        id: 'gemini-2.5-flash-native-audio-preview-12-2025',
        label: 'Gemini 2.5 Flash Live',
        description: '$ Low-latency native audio — cost-efficient multimodal',
      },
      {
        id: 'gemini-2.0-flash-live-preview',
        label: 'Gemini 2.0 Flash Live',
        description: '$ Earlier live preview — lighter workloads',
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    description: 'Claude voice / realtime (when available on your account)',
    envKeys: [
      { envVar: 'ANTHROPIC_API_KEY', label: 'API Key', minLength: 20, secret: true },
    ],
    knownModels: [
      {
        id: 'claude-haiku-4-20250514',
        label: 'Claude Haiku 4',
        description: '$ Fastest / lowest cost — voice placeholder',
      },
      {
        id: 'claude-sonnet-4-20250514',
        label: 'Claude Sonnet 4',
        description: '$$ Balanced quality — voice placeholder',
      },
    ],
  },
  {
    id: 'amazon_bedrock',
    displayName: 'Amazon Bedrock',
    description:
      'Nova Sonic voice — requires IAM access keys (not Bedrock ABSK API keys). Bridge relay in us-east-1.',
    envKeys: [
      {
        envVar: 'AWS_ACCESS_KEY_ID',
        label: 'IAM Access Key ID',
        minLength: 16,
        secret: false,
      },
      {
        envVar: 'AWS_SECRET_ACCESS_KEY',
        label: 'IAM Secret Access Key',
        minLength: 20,
        secret: true,
      },
      {
        envVar: 'AWS_BEARER_TOKEN_BEDROCK',
        label: 'Bedrock API Key (text only — not for voice)',
        minLength: 40,
        secret: true,
        optional: true,
      },
      {
        envVar: 'AWS_REGION',
        label: 'Region',
        minLength: 5,
        secret: false,
        optional: true,
      },
    ],
    knownModels: [
      {
        id: 'amazon.nova-2-sonic-v1:0',
        label: 'Nova 2 Sonic',
        description: '$$ Best Bedrock S2S — polyglot, async tools, 1M context',
      },
      {
        id: 'amazon.nova-sonic-v1:0',
        label: 'Nova Sonic v1',
        description: '$$ Original Nova Sonic — stable speech-to-speech',
      },
    ],
  },
];

export const PROVIDER_MAP = new Map<ProviderId, ProviderDefinition>(
  PROVIDER_DEFINITIONS.map((d) => [d.id, d]),
);

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  const def = PROVIDER_MAP.get(id);
  if (!def) throw new Error(`Unknown provider: ${id}`);
  return def;
}

/** Default AWS region when AWS_REGION is unset (Nova Sonic available in us-east-1). */
export const DEFAULT_AWS_REGION = 'us-east-1';
