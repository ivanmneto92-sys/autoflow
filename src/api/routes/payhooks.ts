/**
 * Notificações dos provedores de Pix. Não confiamos no corpo: só usamos o ID para
 * consultar o pagamento na API do provedor (com a chave do próprio negócio).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeEqual } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';
import { PgPaymentGateway } from '../../payments/gateway.js';
import { scheduledQueue } from '../../queue/queues.js';

const uuid = z.string().uuid();

export async function payhookRoutes(app: FastifyInstance) {
  const sql = db();
  const gateway = new PgPaymentGateway(sql);

  async function handle(ws: string, provider: 'mercadopago' | 'asaas', providerId: string) {
    const [p] = await sql`
      select id, session_id from autoflow.payments
      where workspace_id = ${ws} and provider = ${provider} and provider_id = ${providerId}`;
    if (!p) return;
    const status = await gateway.refresh(p.id as string);
    if (status !== 'pending' && p.session_id)
      await scheduledQueue().add('payment_update', { kind: 'payment_update', sessionId: p.session_id as string, paymentId: p.id as string });
  }

  app.post('/webhooks/mercadopago/:ws', async (req, reply) => {
    const ws = uuid.safeParse((req.params as { ws: string }).ws);
    if (!ws.success) return reply.code(404).send();
    const q = req.query as Record<string, string | undefined>;
    const b = (req.body ?? {}) as { type?: string; action?: string; data?: { id?: string | number } };
    const id = String(b.data?.id ?? q['data.id'] ?? q.id ?? '');
    const type = b.type ?? q.type ?? q.topic;
    if (id && (type === 'payment' || b.action?.startsWith('payment')))
      await handle(ws.data, 'mercadopago', id).catch((err) => req.log.warn({ err }, 'Webhook Mercado Pago'));
    return reply.code(200).send({ ok: true });
  });

  app.post('/webhooks/asaas/:ws', async (req, reply) => {
    const ws = uuid.safeParse((req.params as { ws: string }).ws);
    if (!ws.success) return reply.code(404).send();
    const [acc] = await sql`select webhook_token from autoflow.payment_accounts where workspace_id = ${ws.data} and provider = 'asaas'`;
    const token = req.headers['asaas-access-token'];
    if (!acc || typeof token !== 'string' || !safeEqual(token, acc.webhook_token as string)) return reply.code(401).send();
    const b = (req.body ?? {}) as { event?: string; payment?: { id?: string } };
    if (b.payment?.id) await handle(ws.data, 'asaas', b.payment.id).catch((err) => req.log.warn({ err }, 'Webhook Asaas'));
    return reply.code(200).send({ received: true });
  });
}
