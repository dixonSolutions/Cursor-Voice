/**
 * config.json read/write — operational settings only (no secrets).
 */

import type { FastifyInstance } from 'fastify';
import { ConfigFileSchema, getCachedConfigFile } from '../config.js';
import { writeConfigFile } from '../state/configFile.js';
import { childLogger } from '../log.js';

const log = childLogger('configRoute');

function handleError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('not found') || message.includes('Invalid config')) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/config — full config.json (from memory cache). */
  app.get('/api/config', async (_req, reply) => {
    try {
      return getCachedConfigFile();
    } catch (err) {
      const { status, message } = handleError(err);
      return reply.code(status).send({ error: message });
    }
  });

  /** PUT /api/config — replace config.json body (validated). */
  app.put<{ Body: unknown }>('/api/config', async (req, reply) => {
    try {
      const parsed = ConfigFileSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: `Invalid config.json:\n${parsed.error.message}`,
        });
      }
      writeConfigFile(parsed.data);
      log.info('config.json updated via API');
      return { ok: true };
    } catch (err) {
      const { status, message } = handleError(err);
      return reply.code(status).send({ error: message });
    }
  });
}
