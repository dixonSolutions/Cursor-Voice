/**
 * Voice provider management API.
 *
 * Security:
 *   - All routes require app token (server preHandler).
 *   - Secret values NEVER returned — only configured/complete status.
 *   - Key updates write to .env server-side; audited without logging values.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getVoiceProvidersView,
  registerProvider,
  unregisterProvider,
  setDefaultProvider,
  setProviderDefaultModel,
  addProviderModel,
  removeProviderModel,
  setWakeWords,
} from '../realtime/providerRegistry.js';
import { isProviderId } from '../realtime/provider_keys.js';
import { updateProviderEnvKeys } from '../state/envFile.js';
import { childLogger } from '../log.js';

const log = childLogger('api:voice');

const ProviderIdParamSchema = z.object({
  id: z.string().refine(isProviderId, 'Invalid provider id'),
});

const ModelIdParamSchema = ProviderIdParamSchema.extend({
  modelId: z.string().min(1),
});

const SetDefaultModelBodySchema = z.object({
  modelId: z.string().min(1),
});

const UpdateKeysBodySchema = z.object({
  keys: z.record(z.string(), z.string()),
});

function handleError(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const clientErrors = [
    'not registered',
    'not viable',
    'Unknown provider',
    'already exists',
    'not found',
    'Cannot remove',
    'too short',
    'not valid',
    'Invalid args',
  ];
  const status = clientErrors.some((s) => message.includes(s)) ? 400 : 500;
  return { status, message };
}

export async function registerVoiceProviderRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/voice/providers — catalog + configured state (no secrets). */
  app.get('/api/voice/providers', async () => getVoiceProvidersView());

  /** POST /api/voice/providers { id } — register a viable provider. */
  app.post<{ Body: { id: string } }>('/api/voice/providers', async (req, reply) => {
    try {
      if (!isProviderId(req.body?.id)) {
        return reply.code(400).send({ error: 'Invalid provider id' });
      }
      return registerProvider(req.body.id);
    } catch (err) {
      const { status, message } = handleError(err);
      log.warn({ err }, 'register provider failed');
      return reply.code(status).send({ error: message });
    }
  });

  /** DELETE /api/voice/providers/:id */
  app.delete<{ Params: { id: string } }>('/api/voice/providers/:id', async (req, reply) => {
    try {
      const parsed = ProviderIdParamSchema.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid provider id' });
      return unregisterProvider(parsed.data.id);
    } catch (err) {
      const { status, message } = handleError(err);
      return reply.code(status).send({ error: message });
    }
  });

  /** PUT /api/voice/default-provider { id } */
  app.put<{ Body: { id: string } }>('/api/voice/default-provider', async (req, reply) => {
    try {
      if (!isProviderId(req.body?.id)) {
        return reply.code(400).send({ error: 'Invalid provider id' });
      }
      return setDefaultProvider(req.body.id);
    } catch (err) {
      const { status, message } = handleError(err);
      return reply.code(status).send({ error: message });
    }
  });

  /** PATCH /api/voice/providers/:id/default-model { modelId } */
  app.patch<{ Params: { id: string }; Body: { modelId: string } }>(
    '/api/voice/providers/:id/default-model',
    async (req, reply) => {
      try {
        const params = ProviderIdParamSchema.safeParse(req.params);
        const body = SetDefaultModelBodySchema.safeParse(req.body);
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: 'Invalid request' });
        }
        return setProviderDefaultModel(params.data.id, body.data.modelId);
      } catch (err) {
        const { status, message } = handleError(err);
        return reply.code(status).send({ error: message });
      }
    },
  );

  /** POST /api/voice/providers/:id/models { id, label? } */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/voice/providers/:id/models',
    async (req, reply) => {
      try {
        const params = ProviderIdParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: 'Invalid provider id' });
        return addProviderModel(params.data.id, req.body);
      } catch (err) {
        const { status, message } = handleError(err);
        return reply.code(status).send({ error: message });
      }
    },
  );

  /** DELETE /api/voice/providers/:id/models/:modelId */
  app.delete<{ Params: { id: string; modelId: string } }>(
    '/api/voice/providers/:id/models/:modelId',
    async (req, reply) => {
      try {
        const params = ModelIdParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: 'Invalid params' });
        return removeProviderModel(params.data.id, params.data.modelId);
      } catch (err) {
        const { status, message } = handleError(err);
        return reply.code(status).send({ error: message });
      }
    },
  );

  /**
   * PUT /api/voice/providers/:id/keys { keys: { ENV_VAR: "value", ... } }
   * Writes to .env — never returns current values.
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/voice/providers/:id/keys',
    async (req, reply) => {
      try {
        const params = ProviderIdParamSchema.safeParse(req.params);
        const body = UpdateKeysBodySchema.safeParse(req.body);
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: 'Invalid request body' });
        }
        updateProviderEnvKeys(params.data.id, body.data.keys);
        return getVoiceProvidersView();
      } catch (err) {
        const { status, message } = handleError(err);
        log.warn({ err }, 'update provider keys failed');
        return reply.code(status).send({ error: message });
      }
    },
  );

  /** PATCH /api/voice/wake-words { start, stop } */
  app.patch<{ Body: { start: string; stop: string } }>(
    '/api/voice/wake-words',
    async (req, reply) => {
      try {
        return setWakeWords(req.body);
      } catch (err) {
        const { status, message } = handleError(err);
        return reply.code(status).send({ error: message });
      }
    },
  );
}
