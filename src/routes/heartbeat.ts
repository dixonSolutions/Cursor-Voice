/**
 * Heartbeat admin routes — self-hosting / auto-update control.
 *
 * Routes:
 *   GET  /api/admin/heartbeat         — config + live status
 *   PATCH /api/admin/heartbeat        — update heartbeat settings
 *   POST /api/admin/heartbeat/run     — trigger manual run (async)
 *   GET  /api/admin/heartbeat/events  — recent step log
 *   POST /api/admin/heartbeat/install — spawn install-systemd.sh
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { readConfigFile, writeConfigFile } from '../state/configFile.js';
import { listHeartbeatEvents } from '../state/heartbeatEvents.js';
import {
  getHeartbeatStatus,
  reconcileHeartbeatScheduler,
  refreshGitSnapshot,
  runHeartbeat,
  spawnInstallSystemd,
} from '../heartbeat/index.js';
import { childLogger } from '../log.js';

const log = childLogger('heartbeatRoutes');

const HeartbeatPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMs: z.number().int().min(60_000).max(86_400_000).optional(),
    autoPull: z.boolean().optional(),
    autoInstallDeps: z.boolean().optional(),
    autoBuild: z.boolean().optional(),
    autoRestart: z.boolean().optional(),
    abortOnLocalChanges: z.boolean().optional(),
    branch: z.string().min(1).max(128).optional().or(z.literal('')),
    repoDir: z.string().min(1).optional().or(z.literal('')),
  })
  .strict();

function applyDeepPatch<T extends object>(target: T, patch: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const patchVal = patch[key];
    if (patchVal !== undefined) {
      result[key] = patchVal as T[keyof T];
    }
  }
  return result;
}

export async function registerHeartbeatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/heartbeat', async () => {
    const { heartbeat } = getConfig().settings;
    let status = getHeartbeatStatus();
    if (!status.git) {
      try {
        await refreshGitSnapshot();
        status = getHeartbeatStatus();
      } catch {
        // git snapshot optional on read
      }
    }
    return { heartbeat, status };
  });

  app.patch<{ Body: unknown }>('/api/admin/heartbeat', async (req, reply) => {
    const parsed = HeartbeatPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    const patch = { ...parsed.data };
    if (patch.branch === '') patch.branch = undefined;
    if (patch.repoDir === '') patch.repoDir = undefined;

    const cfg = readConfigFile();
    cfg.settings.heartbeat = applyDeepPatch(
      cfg.settings.heartbeat,
      patch as Partial<typeof cfg.settings.heartbeat>,
    );
    writeConfigFile(cfg);
    reconcileHeartbeatScheduler();
    log.info('heartbeat settings updated');

    try {
      await refreshGitSnapshot();
    } catch {
      // non-fatal
    }

    return {
      ok: true,
      heartbeat: getConfig().settings.heartbeat,
      status: getHeartbeatStatus(),
    };
  });

  app.post('/api/admin/heartbeat/run', async (_req, reply) => {
    const status = getHeartbeatStatus();
    if (status.running) {
      return reply.code(409).send({ error: 'Heartbeat is already running' });
    }

    const runId = randomUUID();
    void runHeartbeat('manual')
      .then((result) => {
        log.info({ runId: result.runId, outcome: result.outcome }, 'manual heartbeat finished');
      })
      .catch((err) => {
        log.error({ err, runId }, 'manual heartbeat failed');
      });

    return { ok: true, started: true, runId };
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/api/admin/heartbeat/events',
    async (req) => {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      return { entries: listHeartbeatEvents(limit) };
    },
  );

  app.post('/api/admin/heartbeat/install', async () => {
    const repoDir = getConfig().settings.heartbeat.repoDir?.trim() || process.cwd();
    const result = spawnInstallSystemd(repoDir);
    return { ok: result.ok, detail: result.detail };
  });
}
