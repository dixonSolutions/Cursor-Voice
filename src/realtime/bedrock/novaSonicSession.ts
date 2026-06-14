import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { randomUUID } from 'node:crypto';

import { FUNCTION_TOOLS } from '../../mcp/functionTools.js';
import { dispatchTool } from '../../mcp/handlers.js';
import { childLogger } from '../../log.js';
import type { SessionConfig } from '../provider.js';
import { getWakeWordsFromConfig } from '../session.js';
import { isStopPhrase } from '../wakeWords.js';
import {
  audioInputEvent,
  promptStartEvent,
  sessionEndEvent,
  sessionStartEvent,
  systemPromptEvents,
  toNovaToolConfiguration,
  toolResultEvents,
  userAudioStartEvent,
} from './events.js';
import type { BedrockAuth } from './credentials.js';

const log = childLogger('bedrock-nova');

/** ~100 ms of silence at 16 kHz — keeps Bedrock stream alive during long tool calls. */
const SILENT_PCM_BASE64 = Buffer.alloc(3200).toString('base64');
/** Bedrock closes the stream if no audio/interactive content for ~55 s. */
const TOOL_KEEPALIVE_MS = 20_000;

export interface NovaSonicCallbacks {
  onConnected(): void;
  onUserTranscript(text: string): void;
  onAssistantTranscript(text: string): void;
  onAudioOutput(base64Pcm: string): void;
  onSpeaking(speaking: boolean): void;
  onWorking(working: boolean): void;
  onDeactivated(phrase: string): void;
  onError(message: string): void;
  onClosed(): void;
}

/** Manages one Nova Sonic bidirectional stream (speech-to-speech). */
export class NovaSonicSession {
  private readonly promptName = randomUUID();
  private readonly audioContentName = randomUUID();
  private client: BedrockRuntimeClient | null = null;
  private sendQueue: string[] = [];
  private sendWaiters: Array<() => void> = [];
  private closed = false;
  private processing = false;
  private toolKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Nova may emit parallel toolUse events — run one at a time. */
  private toolChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly modelId: string,
    private readonly region: string,
    private readonly auth: BedrockAuth,
    private readonly sessionConfig: SessionConfig,
    private readonly sessionKey: string,
    private readonly cb: NovaSonicCallbacks,
  ) {}

  async start(): Promise<void> {
    const handler = new NodeHttp2Handler({
      requestTimeout: 300_000,
      sessionTimeout: 300_000,
      disableConcurrentStreams: false,
    });

    this.client = new BedrockRuntimeClient({
      region: this.region,
      credentials: this.auth.credentials,
      requestHandler: handler,
    });

    const initEvents = this.buildInitEvents();
    for (const e of initEvents) this.enqueue(e);

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: this.modelId,
      body: this.createInputStream(),
    });

    const response = await this.client.send(command);
    this.cb.onConnected();
    void this.processOutput(response.body);
  }

  sendAudio(base64Pcm: string): void {
    if (this.closed) return;
    this.enqueue(
      audioInputEvent(this.promptName, this.audioContentName, base64Pcm),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopToolKeepalive();
    this.enqueue(sessionEndEvent());
    this.flushWaiters();
    this.client?.destroy();
    this.client = null;
    this.cb.onClosed();
  }

  private buildInitEvents(): string[] {
    const toolConfig = toNovaToolConfiguration(FUNCTION_TOOLS);
    const systemContent = randomUUID();
    return [
      sessionStartEvent(),
      promptStartEvent(this.promptName, toolConfig),
      ...systemPromptEvents(this.promptName, systemContent, this.sessionConfig.instructions),
      userAudioStartEvent(this.promptName, this.audioContentName),
    ];
  }

  private enqueue(eventJson: string): void {
    this.sendQueue.push(eventJson);
    this.flushWaiters();
  }

  private flushWaiters(): void {
    while (this.sendWaiters.length > 0 && this.sendQueue.length > 0) {
      this.sendWaiters.shift()?.();
    }
  }

  private async *createInputStream(): AsyncGenerator<{ chunk: { bytes: Uint8Array } }> {
    while (!this.closed) {
      while (this.sendQueue.length === 0 && !this.closed) {
        await new Promise<void>((resolve) => this.sendWaiters.push(resolve));
      }
      const next = this.sendQueue.shift();
      if (!next) break;
      yield { chunk: { bytes: new TextEncoder().encode(next) } };
    }
  }

  private async processOutput(
    body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> | undefined,
  ): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      if (!body) throw new Error('Bedrock returned empty response body');

      for await (const part of body) {
        if (this.closed) break;
        const bytes = part.chunk?.bytes;
        if (!bytes) continue;

        const text = new TextDecoder().decode(bytes);
        let json: { event?: Record<string, unknown> };
        try {
          json = JSON.parse(text) as { event?: Record<string, unknown> };
        } catch {
          continue;
        }

        const event = json.event;
        if (!event) continue;

        if ('textOutput' in event) {
          const out = event['textOutput'] as { content?: string; role?: string };
          const content = out.content?.trim() ?? '';
          if (!content || content.includes('"interrupted"')) continue;
          if (out.role === 'USER') {
            this.cb.onUserTranscript(content);
            const { stop } = getWakeWordsFromConfig();
            if (isStopPhrase(content, stop)) {
              this.cb.onDeactivated(stop);
            }
          } else {
            this.cb.onAssistantTranscript(content);
          }
        }

        if ('audioOutput' in event) {
          const audio = event['audioOutput'] as { content?: string };
          if (audio.content) {
            this.cb.onSpeaking(true);
            this.cb.onAudioOutput(audio.content);
          }
        }

        if ('toolUse' in event) {
          const tool = event['toolUse'] as {
            toolUseId?: string;
            toolName?: string;
            content?: string;
          };
          if (tool.toolUseId && tool.toolName) {
            log.info({ tool: tool.toolName, toolUseId: tool.toolUseId }, 'nova toolUse');
            this.scheduleToolUse(tool.toolName, tool.toolUseId, tool.content ?? '');
          }
        }

        if ('contentEnd' in event) {
          this.cb.onSpeaking(false);
        }

        if ('completionEnd' in event) {
          this.cb.onWorking(false);
        }
      }
    } catch (err) {
      log.error({ err }, 'bedrock output stream error');
      this.cb.onError(err instanceof Error ? err.message : String(err));
    } finally {
      this.processing = false;
      if (!this.closed) void this.close();
    }
  }

  private scheduleToolUse(toolName: string, toolUseId: string, rawArgs: string): void {
    this.toolChain = this.toolChain
      .then(async () => {
        this.cb.onWorking(true);
        await this.handleToolUse(toolName, toolUseId, rawArgs);
      })
      .catch((err) => {
        log.error({ err, tool: toolName }, 'serialized tool failed');
        this.cb.onWorking(false);
      });
  }

  private async handleToolUse(toolName: string, toolUseId: string, rawArgs: string): Promise<void> {
    let args: unknown = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      args = {};
    }

    this.startToolKeepalive();

    let resultJson: string;
    try {
      const result = await dispatchTool(toolName, args, this.sessionKey);
      resultJson = JSON.stringify(result ?? {});
    } catch (err) {
      resultJson = JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.stopToolKeepalive();
    }

    if (this.closed) {
      log.warn({ tool: toolName }, 'tool finished after session closed — result dropped');
      this.cb.onWorking(false);
      return;
    }

    const contentName = randomUUID();
    for (const e of toolResultEvents(this.promptName, contentName, toolUseId, resultJson)) {
      this.enqueue(e);
    }
    this.cb.onWorking(false);
  }

  /** Send silent audio so Bedrock does not time out during multi-minute tool calls. */
  private startToolKeepalive(): void {
    this.stopToolKeepalive();
    this.sendAudio(SILENT_PCM_BASE64);
    this.toolKeepaliveTimer = setInterval(() => {
      if (this.closed) {
        this.stopToolKeepalive();
        return;
      }
      this.sendAudio(SILENT_PCM_BASE64);
    }, TOOL_KEEPALIVE_MS);
  }

  private stopToolKeepalive(): void {
    if (this.toolKeepaliveTimer) {
      clearInterval(this.toolKeepaliveTimer);
      this.toolKeepaliveTimer = null;
    }
  }
}
