import { GraphIgClient } from '../instagram/client.js';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { consumeHourlyQuota, redis } from '../lib/redis.js';
import { scheduledQueue } from '../queue/queues.js';
import { PgPaymentGateway } from '../payments/gateway.js';
import { PgStore } from '../store/pg.js';
import { Engine } from './engine.js';

/** Motor com as dependências reais (banco, Graph API, fila). Usado pelo worker e pelo simulador. */
export function createEngine(): Engine {
  const r = redis();
  return new Engine({
    store: new PgStore(db()),
    ig: new GraphIgClient(),
    payments: new PgPaymentGateway(db()),
    log: logger,
    consumeQuota: (accountId, limit) => consumeHourlyQuota(r, accountId, limit),
    scheduler: {
      async schedule(job, delayMs) {
        await scheduledQueue().add(job.kind, job, { delay: Math.max(0, delayMs) });
      },
    },
  });
}
