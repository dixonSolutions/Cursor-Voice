/**
 * Agent management tool handlers for the MCP SSE server.
 *
 * Exposes Cursor's agent lifecycle to the conversational agent:
 *   list_agents()                    — all running agent sessions
 *   get_agent_status(id)             — detailed status for one agent
 *   spawn_agent(instructions, mode?) — start a new worker session
 *   stop_agent(id)                   — terminate a worker
 *   inject(id, message)              — best-effort context injection
 *   set_mode(id, mode)               — change a session's mode
 *   execute_plan(id)                 — trigger plan execution
 *
 * Handlers are scoped per MCP session key (Mcp-Session-Id header).
 *
 * See docs/16-mcp-server-cursor-as-brain.md § 4.
 */

import { childLogger } from '../../log.js';
import {
  getActiveAgentRun,
  getActiveAgentActivity,
  isAgentBusy,
  killActiveAgent,
} from '../../executor/agentSingleton.js';
import { submitJob } from '../../executor/jobManager.js';
import { resolveProject, getSessionState } from '../../state/registry.js';
import { getJob } from '../../state/jobs.js';
import { dispatchTool } from '../handlers.js';

const log = childLogger('mcp:server:agentTools');

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentEntry {
  id: string;
  kind: string;
  pid: number;
  activity: string | null;
  busy: boolean;
}

export interface ListAgentsResult {
  agents: AgentEntry[];
  count: number;
}

export interface GetAgentStatusArgs {
  id: string;
}

export interface AgentStatusResult {
  id: string;
  found: boolean;
  kind?: string;
  pid?: number;
  activity?: string | null;
  output?: string;
  mode?: string;
  elapsed_ms?: number;
}

export interface SpawnAgentArgs {
  instructions: string;
  mode?: 'agent' | 'plan';
}

export interface SpawnAgentResult {
  job_id: string;
  status: 'running';
  project: string;
  message: string;
}

export interface StopAgentArgs {
  id: string;
}

export interface StopAgentResult {
  ok: boolean;
  message: string;
}

export interface InjectArgs {
  id: string;
  message: string;
}

export interface InjectResult {
  ok: boolean;
  delivered: boolean;
  message: string;
}

export interface SetModeArgs {
  id: string;
  mode: 'ask' | 'agent' | 'debug' | 'plan';
}

export interface SetModeResult {
  ok: boolean;
  message: string;
}

export interface ExecutePlanArgs {
  id: string;
}

export interface ExecutePlanResult {
  ok: boolean;
  message: string;
}

export interface AgentToolHandlers {
  handleListAgents: () => ListAgentsResult;
  handleGetAgentStatus: (args: GetAgentStatusArgs) => Promise<AgentStatusResult>;
  handleSpawnAgent: (args: SpawnAgentArgs) => Promise<SpawnAgentResult>;
  handleStopAgent: (args: StopAgentArgs) => Promise<StopAgentResult>;
  handleInject: (args: InjectArgs) => Promise<InjectResult>;
  handleSetMode: (args: SetModeArgs) => Promise<SetModeResult>;
  handleExecutePlan: (args: ExecutePlanArgs) => Promise<ExecutePlanResult>;
}

// ── Factory (session-scoped) ──────────────────────────────────────────────

/** Build agent tool handlers bound to a specific MCP session key. */
export function makeAgentHandlers(sessionKey: string): AgentToolHandlers {
  return {
    handleListAgents(): ListAgentsResult {
      const active = getActiveAgentRun();
      if (!active) {
        return { agents: [], count: 0 };
      }

      return {
        agents: [
          {
            id: active.refId,
            kind: active.kind,
            pid: active.pid,
            activity: getActiveAgentActivity(),
            busy: true,
          },
        ],
        count: 1,
      };
    },

    async handleGetAgentStatus(args: GetAgentStatusArgs): Promise<AgentStatusResult> {
      const active = getActiveAgentRun();

      if (!active || active.refId !== args.id) {
        try {
          const job = getJob(args.id);
          if (job) {
            return {
              id: args.id,
              found: true,
              kind: 'job',
              activity: `Completed — status: ${job.status}`,
              output: job.summary ?? job.error ?? undefined,
            };
          }
        } catch {
          // getJob may throw if id is not a job UUID
        }
        return { id: args.id, found: false };
      }

      const summary = active.watcher?.getSummary();
      const elapsedMs = summary
        ? Date.now() - summary.startedAt.getTime()
        : undefined;

      return {
        id: args.id,
        found: true,
        kind: active.kind,
        pid: active.pid,
        activity: getActiveAgentActivity(),
        output: active.watcher?.getSummary().lastThinking?.slice(-4000),
        elapsed_ms: elapsedMs,
      };
    },

    async handleSpawnAgent(args: SpawnAgentArgs): Promise<SpawnAgentResult> {
      const session = getSessionState(sessionKey);
      const project = resolveProject(session.activeProject ?? '');

      if (!project) {
        throw new Error(
          'No active project set. Ask the user to select a project before spawning a worker.',
        );
      }

      if (isAgentBusy()) {
        const active = getActiveAgentRun();
        throw new Error(
          `A worker agent is already running (id: ${active?.refId}). ` +
            'Call stop_agent() first or wait for it to finish.',
        );
      }

      const result = await submitJob(
        project,
        sessionKey,
        args.instructions,
        args.mode ?? 'agent',
      );
      log.info({ jobId: result.jobId, project: result.project, sessionKey }, 'worker agent spawned');

      return {
        job_id: result.jobId,
        status: 'running',
        project: result.project,
        message: `Worker started (${result.jobId}). Call get_agent_status("${result.jobId}") for progress.`,
      };
    },

    async handleStopAgent(args: StopAgentArgs): Promise<StopAgentResult> {
      const active = getActiveAgentRun();

      if (!active) {
        return { ok: false, message: 'No agent is currently running.' };
      }

      if (active.refId !== args.id) {
        return {
          ok: false,
          message: `Running agent id is "${active.refId}", not "${args.id}". Use list_agents() to confirm.`,
        };
      }

      killActiveAgent('stopped by voice command');
      log.info({ id: args.id, sessionKey }, 'worker agent stopped');
      return { ok: true, message: `Agent ${args.id} stopped.` };
    },

    async handleInject(args: InjectArgs): Promise<InjectResult> {
      const active = getActiveAgentRun();

      if (!active || active.refId !== args.id) {
        return {
          ok: false,
          delivered: false,
          message: `Agent "${args.id}" is not running. Use list_agents() to verify.`,
        };
      }

      const handle = active.handle as { stdin?: { write?: (s: string) => void } };
      if (handle.stdin?.write) {
        try {
          handle.stdin.write(`\n${args.message}\n`);
          log.info({ id: args.id, msg: args.message.slice(0, 80), sessionKey }, 'inject delivered');
          return { ok: true, delivered: true, message: 'Message injected (best-effort).' };
        } catch (err) {
          log.warn({ err, id: args.id }, 'inject write failed');
        }
      }

      log.warn({ id: args.id, sessionKey }, 'inject not supported — agent has no stdin');
      return {
        ok: true,
        delivered: false,
        message:
          'Agent is running but stdin injection is not supported. ' +
          'If context is critical, call stop_agent() then spawn_agent() with amended instructions.',
      };
    },

    async handleSetMode(args: SetModeArgs): Promise<SetModeResult> {
      try {
        await dispatchTool(
          'cursor_submit',
          {
            prompt: `Switch to ${args.mode} mode for this session`,
            mode: args.mode === 'plan' ? 'plan' : 'agent',
          },
          sessionKey,
        );
        return {
          ok: true,
          message: `Mode change to "${args.mode}" requested for agent ${args.id}.`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },

    async handleExecutePlan(args: ExecutePlanArgs): Promise<ExecutePlanResult> {
      try {
        const result = await dispatchTool(
          'cursor_submit',
          { prompt: 'Execute the plan', mode: 'agent' },
          sessionKey,
        );
        return {
          ok: true,
          message: `Plan execution started for agent ${args.id}. Result: ${JSON.stringify(result)}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

/** Default handlers for non-MCP callers (legacy 'default' session key). */
const defaultHandlers = makeAgentHandlers('default');

export const handleListAgents = defaultHandlers.handleListAgents;
export const handleGetAgentStatus = defaultHandlers.handleGetAgentStatus;
export const handleSpawnAgent = defaultHandlers.handleSpawnAgent;
export const handleStopAgent = defaultHandlers.handleStopAgent;
export const handleInject = defaultHandlers.handleInject;
export const handleSetMode = defaultHandlers.handleSetMode;
export const handleExecutePlan = defaultHandlers.handleExecutePlan;
