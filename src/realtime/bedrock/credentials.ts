import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export type BedrockAuth = { mode: 'iam'; credentials: BedrockCredentials };

export interface BedrockEnv {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

export const NOVA_SONIC_VOICE_ERROR =
  'Nova Sonic voice requires IAM access keys (AWS_ACCESS_KEY_ID starting with AKIA…). ' +
  'Bedrock API keys (BedrockAPIKey-… / ABSK…) are not valid here — STS rejects them and Nova Sonic cannot use API-key auth.';

function isBedrockApiKeyAccessId(accessKeyId: string): boolean {
  return accessKeyId.startsWith('BedrockAPIKey-');
}

/** Resolve IAM credentials for Nova Sonic — API keys are not supported for voice. */
export function resolveBedrockAuth(env: BedrockEnv): BedrockAuth {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    if (isBedrockApiKeyAccessId(accessKeyId)) {
      throw new Error(NOVA_SONIC_VOICE_ERROR);
    }
    return { mode: 'iam', credentials: { accessKeyId, secretAccessKey } };
  }

  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    throw new Error(NOVA_SONIC_VOICE_ERROR);
  }

  throw new Error(
    'Bedrock voice credentials missing — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env',
  );
}

/** True when IAM access keys are configured (required for Nova Sonic voice). */
export function isBedrockEnvViable(env: BedrockEnv): boolean {
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!id || !secret || id.length < 16 || secret.length < 20) return false;
  if (isBedrockApiKeyAccessId(id)) return false;
  return true;
}

/** Whether only a Bedrock API key is set (insufficient for Nova Sonic voice). */
export function hasBedrockApiKeyOnly(env: BedrockEnv): boolean {
  return Boolean(env.AWS_BEARER_TOKEN_BEDROCK?.trim()) && !isBedrockEnvViable(env);
}

/** Verify IAM credentials before minting a Nova Sonic voice session. */
export async function validateBedrockCredentials(
  region: string,
  auth: BedrockAuth,
): Promise<void> {
  const client = new STSClient({
    region,
    credentials: auth.credentials,
  });

  try {
    await client.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`AWS credentials invalid (${region}): ${msg}`);
  } finally {
    client.destroy();
  }
}
