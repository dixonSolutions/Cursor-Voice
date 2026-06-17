/**
 * Ask Claude to summarise older conversation turns (memory compaction).
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { getConfig } from '../config.js';
import { resolveBedrockAuth } from '../realtime/bedrock/credentials.js';
import { resolveBedrockConverseModelId } from '../realtime/bedrock/converseModelId.js';
import type { TurnMessage } from './memory.js';

function bedrockClient(): BedrockRuntimeClient {
  const { env } = getConfig();
  const { llm } = getConfig().settings.workflow.llmIntelligence;
  const auth = resolveBedrockAuth(env);
  return new BedrockRuntimeClient({
    region: llm.region,
    credentials: auth.credentials,
  });
}

export async function summarizeHistory(
  turns: TurnMessage[],
  priorSummary: string | null,
): Promise<string> {
  const { llm, memory } = getConfig().settings.workflow.llmIntelligence;
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  const prior = priorSummary ? `Prior summary:\n${priorSummary}\n\n` : '';

  const prompt =
    `${prior}Summarise the following voice conversation in exactly ${memory.summarySentences} short sentences. ` +
    'Focus on tasks requested, Cursor jobs, and outcomes — omit pleasantries.\n\n' +
    transcript;

  const messages: Message[] = [
    { role: 'user', content: [{ text: prompt }] },
  ];

  const client = bedrockClient();
  const modelId = resolveBedrockConverseModelId(llm.model, llm.region);
  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        messages,
        inferenceConfig: { maxTokens: 512, temperature: 0.2 },
      }),
    );

    const text = response.output?.message?.content
      ?.map((block) => block.text ?? '')
      .join('')
      .trim();

    return text || priorSummary || 'Prior conversation covered coding tasks with Cursor.';
  } finally {
    client.destroy();
  }
}
