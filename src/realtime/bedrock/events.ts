/**
 * Amazon Nova Sonic bidirectional stream event builders.
 * @see https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
 */

import type { FunctionTool } from '../../mcp/functionTools.js';

export const NOVA_AUDIO_INPUT = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
  audioType: 'SPEECH',
  encoding: 'base64',
} as const;

export const NOVA_AUDIO_OUTPUT = {
  mediaType: 'audio/lpcm',
  sampleRateHertz: 24000,
  sampleSizeBits: 16,
  channelCount: 1,
  voiceId: 'matthew',
  encoding: 'base64',
  audioType: 'SPEECH',
} as const;

export function novaEvent(payload: Record<string, unknown>): string {
  return JSON.stringify({ event: payload });
}

export function sessionStartEvent(): string {
  return novaEvent({
    sessionStart: {
      inferenceConfiguration: { maxTokens: 4096, topP: 0.9, temperature: 0.7 },
    },
  });
}

export function toNovaToolConfiguration(tools: FunctionTool[]): { tools: unknown[] } {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: {
          json: JSON.stringify({
            type: 'object',
            properties: t.parameters.properties,
            required: t.parameters.required,
          }),
        },
      },
    })),
  };
}

export function promptStartEvent(
  promptName: string,
  toolConfiguration: { tools: unknown[] },
): string {
  return novaEvent({
    promptStart: {
      promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: NOVA_AUDIO_OUTPUT,
      toolUseOutputConfiguration: { mediaType: 'application/json' },
      toolConfiguration,
    },
  });
}

export function systemPromptEvents(
  promptName: string,
  contentName: string,
  systemPrompt: string,
): string[] {
  return [
    novaEvent({
      contentStart: {
        promptName,
        contentName,
        type: 'TEXT',
        interactive: false,
        role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    }),
    novaEvent({
      textInput: { promptName, contentName, content: systemPrompt },
    }),
    novaEvent({ contentEnd: { promptName, contentName } }),
  ];
}

export function userAudioStartEvent(promptName: string, contentName: string): string {
  return novaEvent({
    contentStart: {
      promptName,
      contentName,
      type: 'AUDIO',
      interactive: true,
      role: 'USER',
      audioInputConfiguration: NOVA_AUDIO_INPUT,
    },
  });
}

export function audioInputEvent(
  promptName: string,
  contentName: string,
  base64Pcm: string,
): string {
  return novaEvent({
    audioInput: { promptName, contentName, content: base64Pcm },
  });
}

export function toolResultEvents(
  promptName: string,
  contentName: string,
  toolUseId: string,
  resultJson: string,
): string[] {
  return [
    novaEvent({
      contentStart: {
        promptName,
        contentName,
        interactive: false,
        type: 'TOOL',
        role: 'TOOL',
        toolResultInputConfiguration: {
          toolUseId,
          type: 'TEXT',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    }),
    novaEvent({
      toolResult: { promptName, contentName, content: resultJson },
    }),
    novaEvent({ contentEnd: { promptName, contentName } }),
  ];
}

export function sessionEndEvent(): string {
  return novaEvent({ sessionEnd: {} });
}
