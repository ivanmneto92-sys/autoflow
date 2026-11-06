/**
 * Confere Pix pendentes de tempos em tempos (garante a confirmação mesmo sem webhook)
 * e acorda o fluxo de quem pagou ou deixou vencer.
 */
import type postgres from 'postgres';
import type { Logger } from 'pino';
import type { ScheduledJob } from '../engine/types.js';
import type { PaymentGateway } from './gateway.js';

export async function checkPendingPayments(
  sql: postgres.Sql,
  gateway: PaymentGateway,
  enqueue: (job: ScheduledJob) => Promise<void>,
  log?: Logger,
): Promise<number> {
  const rows = await sql`
    select id, session_id from autoflow.payments
    where status = 'pending' and provider <> 'simulador' and created_at > now() - interval '3 days'
    order by created_at limit 100`;
  let changed = 0;
  for (const r of rows) {
    try {
      const status = await gateway.refresh(r.id as string);
      if (status !== 'pending') {
        changed++;
        if (r.session_id) await enqueue({ kind: 'payment_update', sessionId: r.session_id as string, paymentId: r.id as string });
      }
    } catch (err) {
      log?.warn({ err, paymentId: r.id }, 'Falha ao consultar Pix');
    }
  }
  return changed;
}

/** Atualiza também os Pix do simulador que venceram. */
export async function expireSimulatorPayments(sql: postgres.Sql, enqueue: (job: ScheduledJob) => Promise<void>) {
  const rows = await sql`
    update autoflow.payments set status = 'expired', updated_at = now()
    where status = 'pending' and provider = 'simulador' and expires_at < now() - interval '2 minutes'
    returning id, session_id`;
  for (const r of rows) if (r.session_id) await enqueue({ kind: 'payment_update', sessionId: r.session_id as string, paymentId: r.id as string });
}
