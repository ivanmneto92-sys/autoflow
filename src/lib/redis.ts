import { Redis } from 'ioredis';
import { config } from '../config.js';

let client: Redis | undefined;

/** Conexão compartilhada (BullMQ exige maxRetriesPerRequest: null). */
export function redis(): Redis {
  if (!client) client = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
  return client;
}

/** Lock simples por chave (ex.: um contato por vez). Retorna função de liberar, ou null se ocupado. */
export async function tryLock(r: Redis, key: string, ttlMs = 30_000): Promise<(() => Promise<void>) | null> {
  const token = Math.random().toString(36).slice(2);
  const ok = await r.set(key, token, 'PX', ttlMs, 'NX');
  if (!ok) return null;
  return async () => {
    // Só libera se ainda for o dono do lock
    await r.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  };
}

/** Contador por janela de 1h. Retorna true se ainda há cota. */
export async function consumeHourlyQuota(r: Redis, accountId: string, limit: number): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `af:quota:${accountId}:${hour}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, 3700);
  return n <= limit;
}
