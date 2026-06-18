/**
 * Shared AWS client factory for intelligence audio (Polly + Transcribe).
 * Uses the same IAM credentials as Bedrock.
 */

import { PollyClient } from '@aws-sdk/client-polly';
import { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { getConfig } from '../../config.js';
import { resolveBedrockAuth } from '../aws/credentials.js';

export function getIntelligenceAwsRegion(): string {
  const { llm, audio } = getConfig().settings.workflow.llmIntelligence;
  return audio.region ?? llm.region;
}

function credentials() {
  return resolveBedrockAuth(getConfig().env).credentials;
}

export function createPollyClient(): PollyClient {
  return new PollyClient({
    region: getIntelligenceAwsRegion(),
    credentials: credentials(),
  });
}

export function createTranscribeStreamingClient(): TranscribeStreamingClient {
  return new TranscribeStreamingClient({
    region: getIntelligenceAwsRegion(),
    credentials: credentials(),
  });
}

/** True when IAM keys are configured (same gate as Bedrock orchestrator). */
export function isAmazonAudioAvailable(): boolean {
  try {
    resolveBedrockAuth(getConfig().env);
    return true;
  } catch {
    return false;
  }
}
