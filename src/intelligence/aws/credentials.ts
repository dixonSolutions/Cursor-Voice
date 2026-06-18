import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export interface AwsIamCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export type AwsAuth = { mode: 'iam'; credentials: AwsIamCredentials };

export interface AwsEnv {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

export const AWS_IAM_KEYS_ERROR =
  'AWS IAM access keys are required (AWS_ACCESS_KEY_ID starting with AKIA…). ' +
  'Bedrock API keys (BedrockAPIKey-… / ABSK…) are not valid for Polly, Transcribe, or Converse.';

function isBedrockApiKeyAccessId(accessKeyId: string): boolean {
  return accessKeyId.startsWith('BedrockAPIKey-');
}

/** Resolve IAM credentials for Bedrock Converse, Polly, and Transcribe. */
export function resolveAwsAuth(env: AwsEnv): AwsAuth {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    if (isBedrockApiKeyAccessId(accessKeyId)) {
      throw new Error(AWS_IAM_KEYS_ERROR);
    }
    return { mode: 'iam', credentials: { accessKeyId, secretAccessKey } };
  }

  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    throw new Error(AWS_IAM_KEYS_ERROR);
  }

  throw new Error(
    'AWS credentials missing — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env',
  );
}

/** True when IAM access keys are configured for Polly / Transcribe / Bedrock Converse. */
export function isAwsEnvViable(env: AwsEnv): boolean {
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!id || !secret || id.length < 16 || secret.length < 20) return false;
  if (isBedrockApiKeyAccessId(id)) return false;
  return true;
}

/** Whether only a Bedrock API key is set (insufficient for IAM-based services). */
export function hasBedrockApiKeyOnly(env: AwsEnv): boolean {
  return Boolean(env.AWS_BEARER_TOKEN_BEDROCK?.trim()) && !isAwsEnvViable(env);
}

/** Verify IAM credentials before calling AWS APIs. */
export async function validateAwsCredentials(region: string, auth: AwsAuth): Promise<void> {
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

/** @deprecated Use resolveAwsAuth */
export const resolveBedrockAuth = resolveAwsAuth;

/** @deprecated Use isAwsEnvViable */
export const isBedrockEnvViable = isAwsEnvViable;

/** @deprecated Use validateAwsCredentials */
export const validateBedrockCredentials = validateAwsCredentials;

export type BedrockCredentials = AwsIamCredentials;
export type BedrockAuth = AwsAuth;
export type BedrockEnv = AwsEnv;
