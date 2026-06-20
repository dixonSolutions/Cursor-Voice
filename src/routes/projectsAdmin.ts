/**
 * Project admin routes — full CRUD for the projects registry.
 *
 * These routes expose paths and full project details to authenticated admin
 * clients (the config tab). Paths are intentionally hidden from the regular
 * GET /api/projects endpoint used by the voice layer.
 *
 * Routes:
 *   GET    /api/admin/projects            — list all projects with paths
 *   POST   /api/admin/projects            — add project
 *   PATCH  /api/admin/projects/:name      — update project
 *   DELETE /api/admin/projects/:name      — soft-delete (disable) project
 *   POST   /api/admin/projects/:name/ping — check if path exists on disk
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { getConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { reconcileRegistry } from '../state/registry.js';
import { getDb } from '../state/db.js';
import { childLogger } from '../log.js';

const log = childLogger('projectsAdmin');

// ── Validation schemas ─────────────────────────────────────────────────────

const ProjectNameParam = z.object({ name: z.string().regex(/^[a-z0-9_-]+$/) });

const ProjectCreateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]+$/, 'Name must be lowercase slug (a-z0-9_-)'),
    path: z.string().min(1, 'Path is required'),
    description: z.string().max(200).optional(),
    aliases: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

const ProjectUpdateSchema = z
  .object({
    path: z.string().min(1).optional(),
    description: z.string().max(200).nullable().optional(),
    aliases: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── Route registration ─────────────────────────────────────────────────────

export async function registerProjectsAdminRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/projects — full project list including paths
  app.get('/api/admin/projects', async () => {
    const cfg = getConfig();
    const db = getDb();

    // Merge config data with registry data (resume_id, model, timestamps)
    const rows = db
      .prepare('SELECT name, path, aliases, description, resume_id, model, enabled, updated_at FROM project ORDER BY name')
      .all() as Array<{
        name: string;
        path: string;
        aliases: string;
        description: string | null;
        resume_id: string | null;
        model: string | null;
        enabled: number;
        updated_at: string;
      }>;

    // Use config as source-of-truth for enabled/path since registry lags until reconcile
    const configByName = new Map(cfg.projects.map((p) => [p.name, p]));

    const projects = rows.map((r) => {
      const cfgProject = configByName.get(r.name);
      let aliases: string[] = [];
      try {
        aliases = JSON.parse(r.aliases) as string[];
      } catch {
        // ignore malformed
      }
      return {
        name: r.name,
        path: cfgProject?.path ?? r.path,
        description: cfgProject?.description ?? r.description ?? null,
        aliases: cfgProject?.aliases ?? aliases,
        enabled: cfgProject?.enabled ?? r.enabled === 1,
        resumeId: r.resume_id,
        model: r.model,
        pathExists: existsSync(cfgProject?.path ?? r.path),
        updatedAt: r.updated_at,
      };
    });

    // Include config projects that may not yet be in registry
    for (const p of cfg.projects) {
      if (!rows.find((r) => r.name === p.name)) {
        projects.push({
          name: p.name,
          path: p.path,
          description: p.description ?? null,
          aliases: p.aliases,
          enabled: p.enabled,
          resumeId: null,
          model: null,
          pathExists: existsSync(p.path),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return { projects };
  });

  // POST /api/admin/projects — add new project
  app.post<{ Body: unknown }>('/api/admin/projects', async (req, reply) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const { name, path, description, aliases, enabled } = parsed.data;

    const cfg = readConfigFile();
    if (cfg.projects.find((p) => p.name === name)) {
      return reply.code(409).send({ error: `Project "${name}" already exists` });
    }

    cfg.projects.push({ name, path, description, aliases, enabled });
    writeConfigFile(cfg);
    reconcileRegistry();

    log.info({ name, path }, 'project added via admin API');
    return {
      ok: true,
      project: { name, path, description: description ?? null, aliases, enabled, pathExists: existsSync(path) },
    };
  });

  // PATCH /api/admin/projects/:name — update project
  app.patch<{ Params: unknown; Body: unknown }>('/api/admin/projects/:name', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    const bodyParsed = ProjectUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: bodyParsed.error.message });
    }

    const cfg = readConfigFile();
    const idx = cfg.projects.findIndex((p) => p.name === name);
    if (idx === -1) {
      return reply.code(404).send({ error: `Project "${name}" not found` });
    }

    const existing = cfg.projects[idx]!;
    const patch = bodyParsed.data;

    cfg.projects[idx] = {
      name: existing.name,
      path: patch.path ?? existing.path,
      description: patch.description !== undefined ? (patch.description ?? undefined) : existing.description,
      aliases: patch.aliases ?? existing.aliases,
      enabled: patch.enabled ?? existing.enabled,
    };

    writeConfigFile(cfg);
    reconcileRegistry();

    const updated = cfg.projects[idx]!;
    log.info({ name }, 'project updated via admin API');
    return {
      ok: true,
      project: {
        ...updated,
        pathExists: existsSync(updated.path),
        description: updated.description ?? null,
      },
    };
  });

  // DELETE /api/admin/projects/:name — soft-delete (disable + remove from config)
  app.delete<{ Params: unknown }>('/api/admin/projects/:name', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    const cfg = readConfigFile();
    const idx = cfg.projects.findIndex((p) => p.name === name);
    if (idx === -1) {
      return reply.code(404).send({ error: `Project "${name}" not found` });
    }

    if (cfg.projects.length === 1) {
      return reply
        .code(400)
        .send({ error: 'Cannot remove the last project — config requires at least one.' });
    }

    cfg.projects.splice(idx, 1);
    writeConfigFile(cfg);
    reconcileRegistry();

    log.info({ name }, 'project removed via admin API');
    return { ok: true, name };
  });

  // POST /api/admin/projects/:name/ping — check if project path exists
  app.post<{ Params: unknown }>('/api/admin/projects/:name/ping', async (req, reply) => {
    const paramsParsed = ProjectNameParam.safeParse(req.params);
    if (!paramsParsed.success) {
      return reply.code(400).send({ error: 'Invalid project name' });
    }
    const { name } = paramsParsed.data;

    const cfg = getConfig();
    const project = cfg.projects.find((p) => p.name === name);
    if (!project) {
      return reply.code(404).send({ error: `Project "${name}" not found` });
    }

    return { name, path: project.path, exists: existsSync(project.path) };
  });
}
