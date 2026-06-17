/**
 * Claude Sonnet orchestrator on Bedrock — agentic loop for llm_intelligence workflow.
 *
 * STT and TTS happen on the phone (WebKit). This module runs the reasoning layer:
 * cached system prompt → tool loop → speak() piped to the phone immediately.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { getConfig } from '../config.js';
import { resolveBedrockAuth } from '../realtime/bedrock/credentials.js';
import { resolveBedrockConverseModelId } from '../realtime/bedrock/converseModelId.js';
import { childLogger } from '../log.js';
import { buildIntelligenceSystemPrompt } from './prompt.js';
import { buildBedrockToolConfig } from './tools.js';
import {
  appendAssistantTurn,
  appendUserTurn,
  buildBedrockMessages,
  type ConversationMemory,
  maybeCompactMemory,
} from './memory.js';
import { executeIntelligenceTool, type ToolExecutionCallbacks } from './executeTool.js';

const log = childLogger('intelligence:orchestrator');
const MAX_TOOL_ITERATIONS = 24;

export interface OrchestratorCallbacks extends ToolExecutionCallbacks {
  onThinking?: (active: boolean) => void;
  onToolActivity?: (tool: string, phase: 'start' | 'done' | 'error', detail?: string) => void;
}

export interface TurnResult {
  assistantText: string;
  toolCalls: number;
}

function createBedrockClient(): BedrockRuntimeClient {
  const { env } = getConfig();
  const { region } = getConfig().settings.workflow.llmIntelligence.llm;
  const auth = resolveBedrockAuth(env);
  return new BedrockRuntimeClient({
    region,
    credentials: auth.credentials,
  });
}

function extractTextBlocks(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

function extractToolUses(blocks: ContentBlock[] | undefined): ToolUseBlock[] {
  if (!blocks) return [];
  return blocks.filter((b): b is ToolUseBlock & ContentBlock => Boolean(b.toolUse)).map((b) => b.toolUse!);
}

export async function runIntelligenceTurn(
  memory: ConversationMemory,
  userTranscript: string,
  sessionKey: string,
  callbacks: OrchestratorCallbacks,
): Promise<TurnResult> {
  appendUserTurn(memory, userTranscript);
  await maybeCompactMemory(memory);

  const { llm } = getConfig().settings.workflow.llmIntelligence;
  const modelId = resolveBedrockConverseModelId(llm.model, llm.region);
  const systemPrompt = buildIntelligenceSystemPrompt();
  const toolConfig = buildBedrockToolConfig();

  const client = createBedrockClient();
  let messages = buildBedrockMessages(memory);
  let iterations = 0;
  let toolCalls = 0;
  const spokenParts: string[] = [];
  let assistantText = '';

  callbacks.onThinking?.(true);

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations += 1;

      const response = await client.send(
        new ConverseCommand({
          modelId,
          system: [
            { text: systemPrompt },
            { cachePoint: { type: 'default' } },
          ],
          messages,
          toolConfig,
          inferenceConfig: {
            maxTokens: llm.maxTokens,
            temperature: 0.4,
          },
        }),
      );

      const output = response.output?.message;
      if (!output) {
        log.warn('empty orchestrator response');
        break;
      }

      const text = extractTextBlocks(output.content);
      if (text) {
        assistantText = assistantText ? `${assistantText}\n${text}` : text;
      }

      const toolUses = extractToolUses(output.content);
      if (toolUses.length === 0) {
        break;
      }

      messages = [...messages, output];
      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUses) {
        if (!toolUse.toolUseId || !toolUse.name) continue;
        toolCalls += 1;

        const input = (toolUse.input as Record<string, unknown>) ?? {};
        const result = await executeIntelligenceTool(
          toolUse.toolUseId,
          toolUse.name,
          input,
          sessionKey,
          callbacks,
        );
        spokenParts.push(...result.spokenTexts);

        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            content: [{ text: result.content }],
            status: 'success',
          },
        });
      }

      messages = [
        ...messages,
        {
          role: 'user',
          content: toolResults,
        },
      ];
    }
  } finally {
    client.destroy();
    callbacks.onThinking?.(false);
  }

  const combinedAssistant = [assistantText, ...spokenParts].filter(Boolean).join('\n');
  if (combinedAssistant) {
    appendAssistantTurn(memory, combinedAssistant);
  }

  return { assistantText: combinedAssistant, toolCalls };
}

/** Verify Bedrock credentials and model access at session start. */
export async function pingIntelligenceOrchestrator(): Promise<void> {
  const client = createBedrockClient();
  const { llm } = getConfig().settings.workflow.llmIntelligence;
  const modelId = resolveBedrockConverseModelId(llm.model, llm.region);
  try {
    await client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: 'user', content: [{ text: 'ping' }] }],
        inferenceConfig: { maxTokens: 8 },
      }),
    );
  } finally {
    client.destroy();
  }
}
