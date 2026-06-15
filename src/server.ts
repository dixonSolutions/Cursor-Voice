/**
 * Fastify server — serves the PWA, exposes /api routes, and runs the
 * authenticated control WebSocket for tool-call relay.
 *
 * All /api/* routes require a valid Bearer token (see auth.ts).
 * Security is enforced at the API level on every request and WS frame.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { requireAuth, verifyWsToken, parseWsAuthMessage } from './auth.js';
import { getDb } from './state/db.js';
import {
  listProjects,
  resolveProject,
  setActiveProject,
  getSessionState,
} from './state/registry.js';
import { getConfig } from './config.js';
import { getRunModeInfo } from './runMode.js';
import { childLogger } from './log.js';
import { dispatchTool } from './mcp/handlers.js';
import { mintToken, hasViableVoiceProvider } from './realtime/token.js';
import { getNarrator, PhoneRelaySession } from './executor/narrator.js';
import { registerVoiceProviderRoutes } from './routes/voiceProviders.js';
import { registerBedrockVoiceWebSocket } from './realtime/bedrock/ws.js';
import { attachDevWebProxy, registerProductionWeb } from './webDispatch.js';

const execFileAsync = promisify(execFile);
const log = childLogger('server');

// ── Health check helpers ──────────────────────────────────────────────────

async function getCursorAgentVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('cursor-agent', ['about', '--format', 'json'], {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout.trim()) as { cliVersion?: string };
    return parsed.cliVersion ?? null;
  } catch {
    return null;
  }
}

// ── Server factory ────────────────────────────────────────────────────────

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);

  // Test mode: allow cross-origin API calls when the PWA is opened directly on the
  // Angular dev port (http://localhost:4200) instead of the unified port.
  if (run.useDevWebServer) {
    const devOrigins = new Set([
      run.webUrl,
      `http://127.0.0.1:${run.webPort}`,
      `http://localhost:${run.webPort}`,
    ]);

    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && devOrigins.has(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      }
      if (req.method === 'OPTIONS') {
        await reply.code(204).send();
      }
    });
  }

  await app.register(fastifyWebsocket);

  const webDistPath = resolve('web/dist');
  const isDevelopment = process.env.NODE_ENV === 'development';

  // ── Unauthenticated routes ─────────────────────────────────────────────

  app.get('/healthz', async (_req, _reply) => {
    const db = getDb();
    const projects = listProjects();
    const cliVersion = await getCursorAgentVersion();
    const { settings } = getConfig();
    const run = getRunModeInfo(settings);
    return {
      status: db.open ? 'ok' : 'degraded',
      db: db.open ? 'ok' : 'error',
      projects: projects.length,
      cliVersion,
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      ts: new Date().toISOString(),
    };
  });

  // ── Auth gate for all /api/* ───────────────────────────────────────────

  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    if (req.url.startsWith('/api/')) {
      await requireAuth(req, reply);
    }
  });

  // ── Project endpoints ──────────────────────────────────────────────────

  /** GET /api/projects — names + descriptions, never paths. */
  app.get('/api/projects', async () => {
    const projects = listProjects();
    return {
      projects: projects.map((p) => ({
        name: p.name,
        description: p.description,
        aliases: p.aliases,
        enabled: p.enabled,
      })),
    };
  });

  /** GET /api/active-project */
  app.get('/api/active-project', async () => {
    const session = getSessionState('default');
    return { activeProject: session.activeProject, activeModel: session.activeModel };
  });

  /** POST /api/active-project { project: string } */
  app.post<{ Body: { project: string } }>(
    '/api/active-project',
    {
      schema: {
        body: {
          type: 'object',
          required: ['project'],
          properties: { project: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const resolved = resolveProject(req.body.project);
      if (!resolved) {
        return reply
          .code(404)
          .send({ error: `Project "${req.body.project}" not found in registry` });
      }
      setActiveProject('default', resolved.name);
      return { activeProject: resolved.name, description: resolved.description };
    },
  );

  // ── Realtime token endpoint ────────────────────────────────────────────

  /**
   * POST /api/realtime/token
   * Mints an ephemeral provider token for the phone to use with WebRTC.
   * The API key NEVER reaches the phone — only the short-lived token does.
   *
   * Body: { voice?: string }
   */
  app.post<{ Body?: { voice?: string } }>('/api/realtime/token', async (req, reply) => {
    if (!hasViableVoiceProvider()) {
      return reply.code(503).send({
        error:
          'No viable voice provider configured. Register a provider and set API keys in Settings.',
      });
    }

    try {
      const voice = req.body?.voice;
      const tokenData = await mintToken(voice);
      return tokenData;
    } catch (err) {
      log.error({ err }, 'token mint failed');
      return reply
        .code(502)
        .send({ error: `Token mint failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  await registerVoiceProviderRoutes(app);

  /** GET /api/settings — non-secret operational settings. */
  app.get('/api/settings', async () => {
    const { settings: s } = getConfig();
    const run = getRunModeInfo(s);
    return {
      runMode: run.runMode,
      backendUrl: run.backendUrl,
      webUrl: run.webUrl,
      publicBaseUrl: run.publicBaseUrl ?? null,
      useDevWebServer: run.useDevWebServer,
      defaultVoiceProvider: s.voice.defaultProvider,
      defaultVoiceModel: s.voice.providers[s.voice.defaultProvider]?.defaultModel ?? null,
      wakeWords: s.voice.wakeWords,
      defaultMode: s.defaultMode,
      maxConcurrentJobs: s.maxConcurrentJobs,
      planFirst: s.planFirst,
      narratorEnabled: s.narratorEnabled,
      narratorCadenceMs: s.narratorCadenceMs,
    };
  });

  // ── Control WebSocket ──────────────────────────────────────────────────
  //
  // Full protocol (all frames are JSON):
  //
  // Phone → Bridge:
  //   { type: "auth", token: "<app-token>" }           First frame — auth
  //   { type: "tool_call", call_id, name, arguments }  Voice provider tool call
  //   { type: "speaking", value: bool }                TTS state update for narrator
  //
  // Bridge → Phone:
  //   { type: "auth_ok" }
  //   { type: "tool_result", call_id, result }
  //   { type: "tool_error",  call_id, error }
  //   { type: "narration",   text, kind? }             Narrator injection

  app.register(async (wsApp) => {
    wsApp.get('/ws/control', { websocket: true }, (socket, _req) => {
      let authenticated = false;
      // Voice tools share session state on the `default` key (same as /api/active-project).
      const sessionKey = 'default';
      let relaySession: PhoneRelaySession | null = null;

      log.debug({ sessionKey }, 'ws connection attempt');

      socket.on('message', (rawMsg: Buffer | string) => {
        const str = typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf-8');

        // ── First frame: authenticate ──────────────────────────────────
        if (!authenticated) {
          const token = parseWsAuthMessage(str);
          if (!verifyWsToken(token)) {
            log.warn({ sessionKey }, 'ws auth failed — closing');
            socket.close(4001, 'Unauthorized');
            return;
          }
          authenticated = true;

          // Wire narrator to this connection.
          relaySession = new PhoneRelaySession((data) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(data);
            }
          });
          void getNarrator().setSession(relaySession);

          socket.send(JSON.stringify({ type: 'auth_ok', sessionKey }));
          log.info({ sessionKey }, 'ws authenticated');
          return;
        }

        // ── Subsequent frames: tool calls + state updates ──────────────
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(str) as Record<string, unknown>;
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          return;
        }

        // TTS state update (for narrator cadence)
        if (msg['type'] === 'speaking' && typeof msg['value'] === 'boolean') {
          relaySession?.setSpeaking(msg['value']);
          return;
        }

        // Tool call relay
        if (msg['type'] === 'tool_call') {
          const callId = typeof msg['call_id'] === 'string' ? msg['call_id'] : randomUUID();
          const toolName = typeof msg['name'] === 'string' ? msg['name'] : '';
          const toolArgs = typeof msg['arguments'] === 'object' ? msg['arguments'] : {};

          log.debug({ sessionKey, tool: toolName, callId }, 'tool call received');

          void dispatchTool(toolName, toolArgs, sessionKey)
            .then((result) => {
              socket.send(
                JSON.stringify({ type: 'tool_result', call_id: callId, result }),
              );
            })
            .catch((err: Error) => {
              socket.send(
                JSON.stringify({
                  type: 'tool_error',
                  call_id: callId,
                  error: err.message,
                }),
              );
            });
          return;
        }

        log.debug({ msg }, 'unhandled ws message type');
      });

      socket.on('close', () => {
        log.info({ sessionKey }, 'ws closed');
        // Detach narrator — events will buffer until next connection.
        if (relaySession) {
          void getNarrator().setSession(null);
          relaySession = null;
        }
      });

      socket.on('error', (err: Error) => {
        log.error({ err, sessionKey }, 'ws error');
      });
    });
  });

  registerBedrockVoiceWebSocket(app);

  // ── Web dispatch (after /api/* and /ws/* routes) ───────────────────────
  //
  // Development: proxy everything else to the Angular dev server (HMR).
  // Production: serve web/dist with SPA index.html fallback.
  if (isDevelopment) {
    attachDevWebProxy(app, run.webPort);
  } else {
    await registerProductionWeb(app, webDistPath);
  }

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'unhandled route error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  log.info(
    {
      webDispatch: isDevelopment ? 'dev-proxy' : 'static',
      webDistPath: isDevelopment ? null : webDistPath,
    },
    'web dispatch configured',
  );

  return app;
}

/** Start listening on 127.0.0.1 (Tailscale proxies externally in serve mode). */
export async function startServer(app: FastifyInstance): Promise<string> {
  const { settings } = getConfig();
  const run = getRunModeInfo(settings);
  const address = await app.listen({ port: run.backendPort, host: '127.0.0.1' });
  log.info(
    {
      address,
      runMode: run.runMode,
      webUrl: run.webUrl,
      useDevWebServer: run.useDevWebServer,
    },
    'bridge listening',
  );
  return address;
}
