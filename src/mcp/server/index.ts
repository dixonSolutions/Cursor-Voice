/**
 * MCP SSE server — exposes cursor-voice tools to Cursor via the MCP protocol.
 *
 * Cursor registers this bridge as an MCP server via global ~/.cursor/mcp.json.
 * Once connected, Cursor's conversational agent can call:
 *   speak / done / next_voice_turn  — voice I/O
 *   list_agents / get_agent_status / spawn_agent / stop_agent / inject — agent management
 *   set_mode / execute_plan / cursor_diff / cursor_revert — mode & git control
 *
 * Transport: MCP Streamable HTTP (superset of SSE, preferred over legacy SSE).
 * Auth: same Bearer token as /api/*.
 *
 * See docs/16-mcp-server-cursor-as-brain.md.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { childLogger } from '../../log.js';
import { verifyWsToken } from '../../auth.js';
import {
  handleSpeak,
  handleDone,
  handleNextVoiceTurn,
} from './voiceToolHandlers.js';
import {
  handleListAgents,
  handleGetAgentStatus,
  handleSpawnAgent,
  handleStopAgent,
  handleInject,
  handleSetMode,
  handleExecutePlan,
} from './agentToolHandlers.js';
import { dispatchTool } from '../handlers.js';
import { cursorVoiceMcpInstructions } from '../loadCursorVoicePrompt.js';

const log = childLogger('mcp:server');

// ── MCP server factory ────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'cursor-voice', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: cursorVoiceMcpInstructions(),
    },
  );

  // ── Voice I/O ──────────────────────────────────────────────────────────

  server.tool(
    'speak',
    'Speak to the user out loud. Call one sentence at a time for low latency. ' +
      'The user cannot see your text — you must call speak() to communicate.',
    { text: z.string().min(1).describe('Exact words to speak to the user.') },
    async ({ text }) => {
      const result = handleSpeak({ text });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'done',
    'Signal that you have finished speaking. The mic re-arms so the user can respond. ' +
      'Call after your last speak() in each turn.',
    {},
    async () => {
      const result = handleDone();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'next_voice_turn',
    'Receive the next user utterance. Long-polls up to timeout_ms (default 30 s). ' +
      'Returns { turn: null } on timeout — call again to keep listening. ' +
      'Always call done() before next_voice_turn() to re-arm the mic first.',
    {
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .describe('Max wait in milliseconds (default 30 000, max 60 000).'),
    },
    async ({ timeout_ms }) => {
      const result = await handleNextVoiceTurn({ timeout_ms });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Agent management ───────────────────────────────────────────────────

  server.tool(
    'list_agents',
    'Return all running agent sessions with id, kind, pid, and current activity. ' +
      'Call before answering "what are you working on?".',
    {},
    async () => {
      const result = handleListAgents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'get_agent_status',
    'Return detailed status — output buffer, mode, elapsed time — for a specific agent.',
    { id: z.string().min(1).describe('Agent / job id from list_agents or spawn_agent.') },
    async ({ id }) => {
      const result = await handleGetAgentStatus({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'spawn_agent',
    "Start a new worker agent session with the given coding instructions. " +
      "Speak to confirm intent first — don't start silently.",
    {
      instructions: z.string().min(1).describe("The coding task — use the user's exact words."),
      mode: z
        .enum(['agent', 'plan'])
        .optional()
        .describe('agent = apply changes immediately; plan = propose only. Default agent.'),
    },
    async ({ instructions, mode }) => {
      const result = await handleSpawnAgent({ instructions, mode });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'stop_agent',
    'Terminate a specific worker agent immediately.',
    { id: z.string().min(1).describe('Agent id from list_agents.') },
    async ({ id }) => {
      const result = await handleStopAgent({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'inject',
    'Send additional context to a running agent (best-effort). ' +
      'If not delivered, fall back to stop_agent() + spawn_agent() with amended instructions.',
    {
      id: z.string().min(1).describe('Agent id.'),
      message: z.string().min(1).describe('Context message to inject.'),
    },
    async ({ id, message }) => {
      const result = await handleInject({ id, message });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Mode & execution control ───────────────────────────────────────────

  server.tool(
    'set_mode',
    'Change the mode of a specific agent session. Scoped to that session — never affects global settings.',
    {
      id: z.string().min(1).describe('Agent id.'),
      mode: z
        .enum(['ask', 'agent', 'debug', 'plan'])
        .describe('Target mode for the session.'),
    },
    async ({ id, mode }) => {
      const result = await handleSetMode({ id, mode });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'execute_plan',
    'Trigger plan execution on an agent that is in plan mode.',
    { id: z.string().min(1).describe('Agent id of the plan-mode session.') },
    async ({ id }) => {
      const result = await handleExecutePlan({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'cursor_diff',
    'Return the current git diff for the active project working directory.',
    {
      id: z
        .string()
        .optional()
        .describe("Session id (defaults to the active session's project)."),
    },
    async ({ id: _id }) => {
      const result = await dispatchTool('cursor_diff', { include_patch: true }, 'default');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'cursor_revert',
    'Revert uncommitted changes in the active project working directory.',
    {
      id: z
        .string()
        .optional()
        .describe("Session id (defaults to the active session's project)."),
    },
    async ({ id: _id }) => {
      const result = await dispatchTool('cursor_revert', {}, 'default');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}

// ── Fastify route registration ────────────────────────────────────────────

/**
 * Per-connection transport map: Mcp-Session-Id → transport.
 * Stateful mode: one transport per Cursor session.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

function requireMcpAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = extractBearerToken(req);
  if (!verifyWsToken(token)) {
    void reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Register the MCP Streamable HTTP routes on the Fastify instance.
 *
 * Protocol (Streamable HTTP):
 *   POST /mcp  (no session)    → initialize → responds with Mcp-Session-Id header
 *   GET  /mcp  (session header) → open SSE stream on the existing transport
 *   POST /mcp  (session header) → JSON-RPC tool calls on the existing transport
 *   DELETE /mcp (session header) → tear down session
 *
 * Every request requires Bearer token auth.
 */
export function registerMcpServer(app: FastifyInstance): void {
  // GET /mcp — open SSE stream on an already-initialized session.
  // Cursor POSTs to initialize first (gets Mcp-Session-Id), then GETs to open the stream.
  app.get('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];

    if (typeof sessionId !== 'string') {
      log.warn('mcp GET — missing Mcp-Session-Id header');
      void reply.code(400).send({
        error: 'Missing Mcp-Session-Id header. POST to /mcp first to initialize a session.',
      });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      log.warn({ sessionId }, 'mcp GET — session not found');
      void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
      return;
    }

    log.debug({ sessionId }, 'mcp GET — opening SSE stream');
    await transport.handleRequest(req.raw, reply.raw, undefined);
  });

  // POST /mcp — initialize (no session) or tool-call dispatch (with session).
  app.post(
    '/mcp',
    { config: { rawBody: true } },
    async (req, reply) => {
      if (!requireMcpAuth(req, reply)) return;

      const sessionId = req.headers['mcp-session-id'];

      if (typeof sessionId === 'string') {
        // Tool call on an existing session.
        const transport = transports.get(sessionId);
        if (!transport) {
          log.warn({ sessionId }, 'mcp POST — session not found');
          void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
          return;
        }
        await transport.handleRequest(req.raw, reply.raw, req.body);
        return;
      }

      // No session header → initialize new session.
      log.debug('mcp POST — initializing new session');
      const newId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
      });

      transports.set(newId, transport);
      transport.onclose = () => {
        transports.delete(newId);
        log.info({ sessionId: newId }, 'mcp session closed');
      };

      const mcpServer = buildMcpServer();
      await mcpServer.connect(transport);
      log.info({ sessionId: newId }, 'mcp session initialized');

      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  );

  // DELETE /mcp — explicit session teardown.
  app.delete('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.close();
        transports.delete(sessionId);
        log.info({ sessionId }, 'mcp session deleted');
      }
    }
    await reply.code(204).send();
  });

  log.info('mcp server registered at /mcp');
}
