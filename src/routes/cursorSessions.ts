/**
 * Cursor CLI session management API — list, select, and create resume threads.
 *
 * Security:
 *   - All routes require app token (server preHandler).
 *   - Project names resolved via registry allowlist.
 *   - session_id selection validated against job history (or current resume_id).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { childLogger } from '../log.js';
import {
  getProjectByName,
  resolveProject,
  setProjectResumeId,
  getSessionState,
} from '../state/registry.js';
import {
  listCursorSessionsForProject,
  listSessionEventLog,
  projectHasCursorSession,
} from '../state/jobs.js';
import { handleNewSession } from '../mcp/tools/session.js';

const log = childLogger('api:cursor-sessions');

const ProjectQuerySchema = z.object({
  project: z.string().min(1),
});

const SelectBodySchema = z.object({
  project: z.string().min(1),
  session_id: z.string().min(1),
});

const NewSessionBodySchema = z.object({
  project: z.string().min(1),
});

const SessionLogsQuerySchema = z.object({
  project: z.string().min(1),
  session_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

function resolveProjectOr404(name: string) {
  const project = resolveProject(name);
  if (!project) {
    throw new Error(`Project "${name}" not found in registry`);
  }
  return project;
}

function isSessionAllowed(projectName: string, sessionId: string): boolean {
  const row = getProjectByName(projectName);
  if (row?.resumeId === sessionId) return true;
  return projectHasCursorSession(projectName, sessionId);
}

export async function registerCursorSessionRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/cursor-sessions?project=name — list known threads + active resume id. */
  app.get<{ Querystring: { project?: string } }>('/api/cursor-sessions', async (req, reply) => {
    const parsed = ProjectQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Query parameter "project" is required' });
    }

    let project;
    try {
      project = resolveProjectOr404(parsed.data.project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: message });
    }

    const row = getProjectByName(project.name);
    const sessions = listCursorSessionsForProject(project.name);

    return {
      project: project.name,
      active_session_id: row?.resumeId ?? null,
      sessions: sessions.map((s) => ({
        session_id: s.sessionId,
        last_prompt: s.lastPrompt,
        last_status: s.lastStatus,
        last_run_at: s.lastRunAt,
        job_count: s.jobCount,
      })),
    };
  });

  /** POST /api/cursor-sessions/select — set project resume_id (continue thread). */
  app.post<{ Body: { project?: string; session_id?: string } }>(
    '/api/cursor-sessions/select',
    async (req, reply) => {
      const parsed = SelectBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }

      let project;
      try {
        project = resolveProjectOr404(parsed.data.project);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: message });
      }

      const { session_id: sessionId } = parsed.data;
      if (!isSessionAllowed(project.name, sessionId)) {
        return reply.code(400).send({
          error: `Session "${sessionId}" is not known for project "${project.name}"`,
        });
      }

      setProjectResumeId(project.name, sessionId);
      log.info({ project: project.name, sessionId }, 'cursor session selected');

      return {
        project: project.name,
        active_session_id: sessionId,
        message: 'Cursor will continue this thread on the next submit.',
      };
    },
  );

  /** GET /api/cursor-sessions/logs — persisted job_event history for a session thread. */
  app.get<{ Querystring: { project?: string; session_id?: string; limit?: string } }>(
    '/api/cursor-sessions/logs',
    async (req, reply) => {
      const parsed = SessionLogsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }

      let project;
      try {
        project = resolveProjectOr404(parsed.data.project);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: message });
      }

      const { session_id: sessionId, limit } = parsed.data;
      if (!isSessionAllowed(project.name, sessionId)) {
        return {
          project: project.name,
          session_id: sessionId,
          entries: [],
        };
      }

      const entries = listSessionEventLog(project.name, sessionId, limit ?? 500);
      return {
        project: project.name,
        session_id: sessionId,
        entries,
      };
    },
  );

  /** POST /api/cursor-sessions/new — create a fresh cursor-agent chat thread. */
  app.post<{ Body: { project?: string } }>('/api/cursor-sessions/new', async (req, reply) => {
    const parsed = NewSessionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    let project;
    try {
      project = resolveProjectOr404(parsed.data.project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: message });
    }

    const session = getSessionState('default');
    const result = await handleNewSession({ project: project.name }, session.activeProject);

    return {
      project: result.project,
      active_session_id: result.session_id,
      message: result.message,
    };
  });
}
