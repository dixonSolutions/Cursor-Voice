import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { randomUUID } from 'node:crypto';

import { VOICE_FUNCTION_TOOLS } from '../../mcp/functionTools.js';
import { dispatchTool } from '../../mcp/handlers.js';
import {
  enrichToolResultForVoice,
  toolDoneLabel,
  toolStartLabel,
} from '../../mcp/toolVoice/index.js';
import { getActiveJobIdForSession } from '../../executor/jobManager.js';
import { getActiveAgentRun, isAgentBusy } from '../../executor/agentSingleton.js';
import { childLogger } from '../../log.js';
import type { SessionConfig } from '../provider.js';
import {
  audioInputEvent,
  promptStartEvent,
  sessionEndEvent,
  sessionStartEvent,
  systemPromptEvents,
  toNovaToolConfiguration,
  toolResultEvents,
  narrationInputEvents,
  userAudioStartEvent,
} from './events.js';
import type { BedrockAuth } from './credentials.js';
import { isLikelyTtsEcho, isLikelyNoiseTranscript } from './echoFilter.js';
import { isMetaVoiceBridgeQuestion, normalizeAskQuestion } from '../../mcp/tools/questionDetect.js';

const log = childLogger('bedrock-nova');

/** Read-only tools that must not wait behind cursor_ask / cursor_submit. */
const QUICK_TOOLS = new Set(['cursor_status', 'cursor_recall_answer']);

/** ~100 ms of silence at 16 kHz — keeps Bedrock stream alive during long tool calls. */
const SILENT_PCM_BASE64 = Buffer.alloc(3200).toString('base64');
/** Bedrock closes the stream if no audio/interactive content for ~55 s. */
const TOOL_KEEPALIVE_MS = 20_000;
/** Baseline ping so Nova can think between tools without killing the stream. */
const SESSION_KEEPALIVE_MS = 15_000;

export interface NovaSonicCallbacks {
  onConnected(): void;
  onUserTranscript(text: string): void;
  onAssistantTranscript(text: string): void;
  onAudioOutput(base64Pcm: string): void;
  onSpeaking(speaking: boolean): void;
  onWorking(working: boolean): void;
  onError(message: string): void;
  onClosed(): void;
  onToolActivity?(event: {
    tool: string;
    phase: 'start' | 'done' | 'error';
    label: string;
    detail?: string;
  }): void;
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
  private jobKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private sessionKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
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
    this.startSessionKeepalive();
    void this.processOutput(response.body);
  }

  sendAudio(base64Pcm: string): void {
    if (this.closed) return;
    this.enqueue(
      audioInputEvent(this.promptName, this.audioContentName, base64Pcm),
    );
  }

  /** Inject a spoken status update (progress narration while tools run). */
  injectNarration(text: string): void {
    if (this.closed || !text.trim()) return;
    const line = text.trim();
    const contentName = randomUUID();
    for (const e of narrationInputEvents(this.promptName, contentName, line)) {
      this.enqueue(e);
    }
    log.debug({ text: text.slice(0, 80) }, 'nova narration injected');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopSessionKeepalive();
    this.stopToolKeepalive();
    this.stopJobKeepalive();
    this.enqueue(sessionEndEvent());
    this.flushWaiters();
    this.client?.destroy();
    this.client = null;
    this.cb.onClosed();
  }

  private buildInitEvents(): string[] {
    const toolConfig = toNovaToolConfiguration(VOICE_FUNCTION_TOOLS);
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
            if (isLikelyTtsEcho(content) || isLikelyNoiseTranscript(content)) {
              log.debug({ content: content.slice(0, 80) }, 'ignored likely noise or TTS echo');
              continue;
            }
            this.cb.onUserTranscript(content);
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
    if (QUICK_TOOLS.has(toolName)) {
      void this.handleToolUse(toolName, toolUseId, rawArgs, { quick: true }).catch((err) => {
        log.error({ err, tool: toolName }, 'quick tool failed');
      });
      return;
    }

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

  private async handleToolUse(
    toolName: string,
    toolUseId: string,
    rawArgs: string,
    opts: { quick?: boolean } = {},
  ): Promise<void> {
    let args: unknown = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      args = {};
    }

    if (toolName === 'cursor_ask' || toolName === 'cursor_submit') {
      const field = toolName === 'cursor_ask' ? 'question' : 'prompt';
      const raw = String((args as Record<string, unknown>)[field] ?? '');
      (args as Record<string, unknown>)[field] = normalizeAskQuestion(raw);
    }

    if (toolName === 'cursor_ask') {
      const q = String((args as Record<string, unknown>)['question'] ?? '');
      if (isLikelyTtsEcho(q) || isMetaVoiceBridgeQuestion(q)) {
        const reject = JSON.stringify({
          error: 'Ignored likely echo or off-topic question.',
          speak_to_user:
            'I am still on your earlier question — I will summarize when Cursor finishes.',
        });
        this.cb.onToolActivity?.({ tool: toolName, phase: 'done', label: 'Waiting for Cursor' });
        const contentName = randomUUID();
        for (const e of toolResultEvents(this.promptName, contentName, toolUseId, reject)) {
          this.enqueue(e);
        }
        if (!opts.quick) this.cb.onWorking(false);
        return;
      }
    }

    const startLabel = toolStartLabel(toolName, args);
    this.cb.onToolActivity?.({ tool: toolName, phase: 'start', label: startLabel });

    if (!opts.quick && toolName === 'cursor_ask' && isAgentBusy()) {
      const busyResult = JSON.stringify({
        error: 'Cursor is already answering a question.',
        speak_to_user:
          'I am still working on your question — I will summarize when Cursor finishes.',
      });
      this.cb.onToolActivity?.({
        tool: toolName,
        phase: 'done',
        label: 'Waiting for Cursor',
      });
      const contentName = randomUUID();
      for (const e of toolResultEvents(this.promptName, contentName, toolUseId, busyResult)) {
        this.enqueue(e);
      }
      this.cb.onWorking(false);
      return;
    }

    if (!opts.quick) {
      this.startToolKeepalive();
    }

    let resultJson: string;
    let parsedResult: Record<string, unknown> = {};
    try {
      const result = await dispatchTool(toolName, args, this.sessionKey);
      parsedResult =
        result && typeof result === 'object'
          ? (result as Record<string, unknown>)
          : { value: result };
      parsedResult = enrichToolResultForVoice(toolName, parsedResult);
      resultJson = JSON.stringify(parsedResult);
      const doneLabel = toolDoneLabel(toolName, parsedResult);
      this.cb.onToolActivity?.({ tool: toolName, phase: 'done', label: doneLabel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parsedResult = { error: message };
      resultJson = JSON.stringify(parsedResult);
      this.cb.onToolActivity?.({
        tool: toolName,
        phase: 'error',
        label: startLabel,
        detail: message,
      });
    } finally {
      this.bumpStreamAlive();
      if (!getActiveJobIdForSession(this.sessionKey) && getActiveAgentRun()?.kind !== 'ask') {
        this.syncToolKeepalive();
      }
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
    if (!opts.quick) {
      this.cb.onWorking(false);
    }

    this.pushAnswerTranscriptForTts(toolName, parsedResult);

    if (!opts.quick && getActiveJobIdForSession(this.sessionKey)) {
      this.startJobKeepalive();
    }
  }

  /** When Nova returns text-only, browser TTS reads the Cursor answer aloud. */
  private pushAnswerTranscriptForTts(tool: string, result: Record<string, unknown>): void {
    if (result['error']) return;
    if (tool !== 'cursor_ask' && tool !== 'cursor_recall_answer') return;
    const answer = typeof result['answer'] === 'string' ? result['answer'].trim() : '';
    if (!answer) return;
    this.cb.onAssistantTranscript(answer);
  }

  private bumpStreamAlive(): void {
    this.startToolKeepalive();
  }

  private syncToolKeepalive(): void {
    const busy =
      getActiveJobIdForSession(this.sessionKey) !== null ||
      getActiveAgentRun()?.kind === 'ask';
    if (busy) return;
    this.stopToolKeepalive();
  }

  /** Always-on silent audio — Bedrock drops the stream after ~55 s of silence. */
  private startSessionKeepalive(): void {
    if (this.sessionKeepaliveTimer) return;
    this.sendAudio(SILENT_PCM_BASE64);
    this.sessionKeepaliveTimer = setInterval(() => {
      if (this.closed) {
        this.stopSessionKeepalive();
        return;
      }
      this.sendAudio(SILENT_PCM_BASE64);
    }, SESSION_KEEPALIVE_MS);
  }

  private stopSessionKeepalive(): void {
    if (this.sessionKeepaliveTimer) {
      clearInterval(this.sessionKeepaliveTimer);
      this.sessionKeepaliveTimer = null;
    }
  }

  /** Keep silent audio flowing while a background job runs (cursor_submit returns immediately). */
  private startJobKeepalive(): void {
    if (this.jobKeepaliveTimer) return;
    this.sendAudio(SILENT_PCM_BASE64);
    this.jobKeepaliveTimer = setInterval(() => {
      if (this.closed) {
        this.stopJobKeepalive();
        return;
      }
      if (!getActiveJobIdForSession(this.sessionKey)) {
        this.stopJobKeepalive();
        return;
      }
      this.sendAudio(SILENT_PCM_BASE64);
    }, TOOL_KEEPALIVE_MS);
  }

  private stopJobKeepalive(): void {
    if (this.jobKeepaliveTimer) {
      clearInterval(this.jobKeepaliveTimer);
      this.jobKeepaliveTimer = null;
    }
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
      this.syncToolKeepalive();
      if (!this.toolKeepaliveTimer) return;
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
