/**
 * Fastify server — serves the PWA, exposes /api routes, and runs the
 * authenticated control WebSocket for tool-call relay.
 *
 * All /api/* routes require a valid Bearer token (see auth.ts).
 * Security is enforced at the API level on every request and WS frame.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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
import { childLogger } from './log.js';
import { dispatchTool } from './mcp/handlers.js';
import { mintToken } from './realtime/token.js';
import { getNarrator, PhoneRelaySession } from './executor/narrator.js';

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

  await app.register(fastifyWebsocket);

  const webDistPath = resolve('web/dist');
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      index: 'index.html',
    });
  }

  // ── Unauthenticated routes ─────────────────────────────────────────────

  app.get('/healthz', async (_req, _reply) => {
    const db = getDb();
    const projects = listProjects();
    const cliVersion = await getCursorAgentVersion();
    return {
      status: db.open ? 'ok' : 'degraded',
      db: db.open ? 'ok' : 'error',
      projects: projects.length,
      cliVersion,
      ts: new Date().toISOString(),
    };
  });

  // ── Auth gate for all /api/* ───────────────────────────────────────────

  app.addHook('preHandler', async (req, reply) => {
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
    const { env } = getConfig();
    if (!env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
      return reply.code(503).send({
        error: 'No voice provider API key configured. Set OPENAI_API_KEY in .env.',
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

  /** GET /api/settings — non-secret operational settings. */
  app.get('/api/settings', async () => {
    const { settings: s } = getConfig();
    return {
      voiceProvider: s.voiceProvider,
      realtimeModel: s.realtimeModel,
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
      // Unique session key per WS connection — used for session state lookup.
      const sessionKey = randomUUID();
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

  app.setErrorHandler((err, req, reply) => {
    log.error({ err, url: req.url }, 'unhandled route error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  const webServing = existsSync(webDistPath)
    ? 'enabled'
    : 'disabled (run npm run build:web first)';
  log.info(`static web serving: ${webServing}`);

  return app;
}

/** Start listening on 127.0.0.1 (Tailscale proxies externally). */
export async function startServer(app: FastifyInstance): Promise<string> {
  const { env } = getConfig();
  const address = await app.listen({ port: env.PORT, host: '127.0.0.1' });
  log.info({ address }, 'bridge listening');
  return address;
}
