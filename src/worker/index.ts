/**
 * Worker: processa webhooks (fila inbound), jobs agendados (atrasos/timeouts), publicações agendadas e manutenção (refresh de tokens).
 * Rodar: npm run dev:worker  |  produção: npm run start:worker
 */
import { DelayedError, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { createEngine } from '../engine/factory.js';
import type { ScheduledJob } from '../engine/types.js';
import { closeDb, db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { redis, tryLock } from '../lib/redis.js';
import {
  QUEUE_INBOUND,
  QUEUE_MAINTENANCE,
  QUEUE_SCHEDULED,
  maintenanceQueue,
  type InboundJob,
} from '../queue/queues.js';
import { GraphIgClient } from '../instagram/client.js';
import { startPublisher } from '../posts/publisher.js';
import { PgPostRepo } from '../posts/repo.js';
import { PgStore } from '../store/pg.js';
import { refreshExpiringTokens } from './maintenance.js';

const cfg = config();
const store = new PgStore(db());
const r = redis();

const engine = createEngine();

/** Garante que um contato é processado por vez (ordem das mensagens). */
async function withContactLock(job: Job, token: string | undefined, key: string, fn: () => Promise<void>) {
  const release = await tryLock(r, `af:lock:${key}`, 60_000);
  if (!release) {
    await job.moveToDelayed(Date.now() + 1000, token);
    throw new DelayedError();
  }
  try {
    await fn();
  } finally {
    await release();
  }
}

function contactKey(job: InboundJob): string {
  const e = job.event;
  switch (e.kind) {
    case 'comment':
      return `${e.igUserId}:${e.fromId}`;
    case 'echo':
      return `${e.igUserId}:${e.recipientId}`;
    default:
      return `${e.igUserId}:${e.senderId}`;
  }
}

const inboundWorker = new Worker<InboundJob>(
  QUEUE_INBOUND,
  async (job, token) => {
    await withContactLock(job, token, contactKey(job.data), () => engine.handleEvent(job.data.event));
  },
  { connection: r, concurrency: cfg.WORKER_CONCURRENCY },
);

const scheduledWorker = new Worker<ScheduledJob>(
  QUEUE_SCHEDULED,
  async (job, token) => {
    // Mesmo lock do inbound (conta:contato) para não correr junto com uma mensagem do cliente
    const session = await store.getSession(job.data.sessionId);
    const contact = session ? await store.getContact(session.contactId) : null;
    const account = contact ? await store.getAccountById(contact.igAccountId) : null;
    if (!contact || !account) return;
    await withContactLock(job, token, `${account.igUserId}:${contact.igsid}`, () => engine.handleScheduled(job.data));
  },
  { connection: r, concurrency: cfg.WORKER_CONCURRENCY },
);

const maintenanceWorker = new Worker(
  QUEUE_MAINTENANCE,
  async (job) => {
    if (job.name === 'refresh_tokens') await refreshExpiringTokens(db(), logger);
  },
  { connection: r, concurrency: 1 },
);

// Refresh de tokens todo dia às 04:17
await maintenanceQueue().upsertJobScheduler('refresh_tokens', { pattern: '17 4 * * *' }, { name: 'refresh_tokens' });

for (const w of [inboundWorker, scheduledWorker, maintenanceWorker]) {
  w.on('failed', (job, err) => logger.error({ err, jobId: job?.id, queue: w.name }, 'Job falhou'));
}

// Publicações agendadas: procura posts vencidos a cada PUBLISH_POLL_SECONDS
const publisher = startPublisher(
  { repo: new PgPostRepo(db(), store), ig: new GraphIgClient(), log: logger },
  cfg.PUBLISH_POLL_SECONDS * 1000,
);

logger.info('Worker autoflow iniciado');

async function shutdown() {
  logger.info('Encerrando worker...');
  await Promise.all([inboundWorker.close(), scheduledWorker.close(), maintenanceWorker.close(), publisher.stop()]);
  await closeDb();
  r.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
