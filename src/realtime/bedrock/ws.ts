/**
 * Authenticated WebSocket relay: PWA ↔ bridge ↔ Amazon Nova Sonic.
 */

import type { FastifyInstance } from 'fastify';
import { verifyWsToken, parseWsAuthMessage } from '../../auth.js';
import { childLogger } from '../../log.js';
import { getConfig } from '../../config.js';
import { NovaSonicSession } from './novaSonicSession.js';
import { consumePendingBedrockSession } from './pendingSessions.js';
import { resolveBedrockAuth } from './credentials.js';
import { setVoiceToolActivityBroadcaster } from '../voiceUiEvents.js';

const log = childLogger('bedrock-ws');

interface VoiceAuthMessage {
  type: 'auth';
  token: string;
  sessionId: string;
}

export function registerBedrockVoiceWebSocket(app: FastifyInstance): void {
  app.get('/ws/voice', { websocket: true }, (socket) => {
    let authenticated = false;
    let nova: NovaSonicSession | null = null;

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = raw.toString();

      if (!authenticated) {
        let msg: VoiceAuthMessage | null = null;
        try {
          const parsed = JSON.parse(text) as VoiceAuthMessage;
          if (parsed.type === 'auth' && parsed.sessionId) msg = parsed;
        } catch {
          const token = parseWsAuthMessage(text);
          if (token) {
            msg = { type: 'auth', token, sessionId: '' };
          }
        }

        if (!msg || !verifyWsToken(msg.token)) {
          socket.close(4001, 'Unauthorized');
          return;
        }

        const pending = consumePendingBedrockSession(msg.sessionId);
        if (!pending) {
          socket.close(4002, 'Session expired — tap to talk again');
          return;
        }

        const { env } = getConfig();
        let auth;
        try {
          auth = resolveBedrockAuth(env);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'AWS Bedrock credentials not configured';
          log.warn({ err }, 'bedrock voice auth failed');
          socket.close(1011, message);
          return;
        }

        authenticated = true;
        /** Same key as /api/active-project — UI project selection applies to voice tools. */
        const voiceSessionKey = 'default';
        nova = new NovaSonicSession(
          pending.model,
          pending.region,
          auth,
          pending.config,
          voiceSessionKey,
          {
            onConnected: () => socket.send(JSON.stringify({ type: 'connected' })),
            onUserTranscript: (t) =>
              socket.send(JSON.stringify({ type: 'user_transcript', text: t })),
            onAssistantTranscript: (t) =>
              socket.send(JSON.stringify({ type: 'assistant_transcript', text: t })),
            onAudioOutput: (content) =>
              socket.send(JSON.stringify({ type: 'audio_out', content })),
            onSpeaking: (value) =>
              socket.send(JSON.stringify({ type: 'speaking', value })),
            onWorking: (working) =>
              socket.send(JSON.stringify({ type: 'working', value: working })),
            onError: (message) => {
              socket.send(JSON.stringify({ type: 'error', message }));
              socket.close(1011, message);
            },
            onClosed: () => socket.close(1000, 'Session ended'),
            onToolActivity: (event) =>
              socket.send(JSON.stringify({ type: 'tool_activity', ...event })),
          },
        );

        setVoiceToolActivityBroadcaster((event) =>
          socket.send(JSON.stringify({ type: 'tool_activity', ...event })),
        );

        void nova.start().catch((err) => {
          const message = err instanceof Error ? err.message : 'Start failed';
          log.error({ err }, 'nova session start failed');
          socket.send(JSON.stringify({ type: 'error', message }));
          socket.close(1011, message);
        });
        return;
      }

      let frame: { type?: string; content?: string };
      try {
        frame = JSON.parse(text) as { type?: string; content?: string };
      } catch {
        return;
      }

      if (frame.type === 'audio' && frame.content && nova) {
        nova.sendAudio(frame.content);
      }

      if (frame.type === 'narration' && frame.content && nova) {
        nova.injectNarration(frame.content);
      }

      if (frame.type === 'close') {
        void nova?.close();
      }
    });

    socket.on('close', () => {
      setVoiceToolActivityBroadcaster(null);
      if (nova) {
        void nova.close().catch(() => undefined);
        nova = null;
      }
    });
  });
}
