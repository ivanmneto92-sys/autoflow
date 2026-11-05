/**
 * API HTTP: OAuth do Instagram, webhooks da Meta e rotas administrativas.
 * Rodar: npm run dev:api  |  produção: npm run start:api
 */
import { config } from '../config.js';
import { closeDb } from '../lib/db.js';
import { redis } from '../lib/redis.js';
import { buildServer } from './app.js';

const app = await buildServer();
// '::' escuta IPv4 e IPv6 (evita erro do ngrok em [::1]); sem IPv6, cai para 0.0.0.0
try {
  await app.listen({ port: config().PORT, host: '::' });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EAFNOSUPPORT') throw err;
  await app.listen({ port: config().PORT, host: '0.0.0.0' });
}

const shutdown = async () => {
  await app.close();
  await closeDb();
  redis().disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
