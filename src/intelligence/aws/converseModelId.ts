/**
 * Resolve Bedrock Converse `modelId` — newer Anthropic models require a regional
 * inference profile prefix (e.g. `us.anthropic.claude-sonnet-4-…`) instead of the
 * base on-demand model ID.
 */

const INFERENCE_PROFILE_PREFIX = /^(global|us|eu|apac|jp)\./;

/** Map AWS region to cross-region inference profile prefix. */
export function bedrockInferencePrefix(region: string): string {
  const r = region.toLowerCase();
  if (r.startsWith('eu-')) return 'eu';
  if (r.startsWith('ap-northeast')) return 'apac';
  if (r.startsWith('ap-')) return 'apac';
  return 'us';
}

/** Resolve config model ID to a Converse-compatible inference profile when needed. */
export function resolveBedrockConverseModelId(modelId: string, region: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('arn:aws:bedrock:')) return trimmed;
  if (INFERENCE_PROFILE_PREFIX.test(trimmed)) return trimmed;
  if (trimmed.startsWith('anthropic.')) {
    return `${bedrockInferencePrefix(region)}.${trimmed}`;
  }
  return trimmed;
}
