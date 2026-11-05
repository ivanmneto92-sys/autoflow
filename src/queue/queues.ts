import { Queue } from 'bullmq';
import type { ScheduledJob } from '../engine/types.js';
import type { InboundEvent } from '../instagram/webhook.js';
import { redis } from '../lib/redis.js';

export const QUEUE_INBOUND = 'af-inbound';
export const QUEUE_SCHEDULED = 'af-scheduled';
export const QUEUE_MAINTENANCE = 'af-maintenance';

export type InboundJob = { event: InboundEvent };

let inbound: Queue<InboundJob> | undefined;
let scheduled: Queue<ScheduledJob> | undefined;
let maintenance: Queue | undefined;

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function inboundQueue() {
  inbound ??= new Queue<InboundJob>(QUEUE_INBOUND, { connection: redis(), defaultJobOptions });
  return inbound;
}

export function scheduledQueue() {
  scheduled ??= new Queue<ScheduledJob>(QUEUE_SCHEDULED, { connection: redis(), defaultJobOptions });
  return scheduled;
}

export function maintenanceQueue() {
  maintenance ??= new Queue(QUEUE_MAINTENANCE, { connection: redis(), defaultJobOptions });
  return maintenance;
}

/** Ecos são atrasados alguns segundos para o bot registrar o `mid` antes (evita pausar o robô por engano). */
export async function enqueueInbound(event: InboundEvent, jobId: string) {
  await inboundQueue().add(event.kind, { event }, { jobId: jobId.replace(/:/g, '_'), delay: event.kind === 'echo' ? 5000 : 0 });
}
