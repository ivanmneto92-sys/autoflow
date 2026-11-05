/** Monta o servidor Fastify (separado do start para facilitar testes). */
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { adminRoutes } from './routes/admin.js';
import { appRoutes, type TokenVerifier } from './routes/app.js';
import { authRoutes } from './routes/auth.js';
import { mediaRoutes } from './routes/media.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildServer(opts: { verifyToken?: TokenVerifier } = {}) {
  const app = Fastify({
    logger: {
      level: config().LOG_LEVEL,
      redact: ['req.headers["x-api-key"]', 'req.headers.authorization'],
      serializers: {
        req(req) {
          return { method: req.method, url: req.url?.split('?')[0], remoteAddress: req.ip };
        },
      },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  // Guarda o corpo bruto para validar a assinatura dos webhooks
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(formbody); // signed_request da Meta vem como form
  await app.register(cors, {
    origin: config().PANEL_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    allowedHeaders: ['Authorization', 'Content-Type', 'x-workspace-id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation', issues: err.issues });
    req.log.error({ err }, 'Erro na requisição');
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: 'internal_error' });
  });

  app.get('/health', async () => {
    await db()`select 1`;
    await redis().ping();
    return { ok: true };
  });

  await app.register(webhookRoutes);
  await app.register(authRoutes);
  await app.register(mediaRoutes);
  await app.register(adminRoutes);
  await app.register(appRoutes, { verifyToken: opts.verifyToken });
  return app;
}

