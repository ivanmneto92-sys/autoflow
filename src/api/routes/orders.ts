/**
 * Pedidos (/app/orders): registrados pela ação "Registrar pedido" do fluxo.
 * O painel lista, muda o status e (dentro da janela de 24h) avisa o cliente no Direct.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GraphIgClient } from '../../instagram/client.js';
import { db } from '../../lib/db.js';
import { PgStore } from '../../store/pg.js';
import { HttpError } from '../http.js';

const uuid = z.string().uuid();
const idOf = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

export const ORDER_STATUSES = ['new', 'preparing', 'delivering', 'done', 'cancelled'] as const;

/** Mensagem enviada ao cliente quando o status muda. */
export function statusMessage(status: (typeof ORDER_STATUSES)[number], n: number): string | null {
  switch (status) {
    case 'preparing':
      return `Seu pedido #${n} está sendo preparado 👨‍🍳`;
    case 'delivering':
      return `Seu pedido #${n} saiu para entrega 🛵`;
    case 'done':
      return `Pedido #${n} concluído. Obrigado pela preferência! 😋`;
    case 'cancelled':
      return `Seu pedido #${n} foi cancelado. Se tiver alguma dúvida, é só responder aqui.`;
    default:
      return null;
  }
}

export async function orderRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();
  const store = new PgStore(sql);
  const ig = new GraphIgClient();

  app.get('/app/orders', async (req) => {
    const { status } = z.object({ status: z.enum(ORDER_STATUSES).optional() }).parse(req.query);
    return sql`
      select o.id, o.number, o.status, o.summary, o.details, o.total_cents, o.payment_status, o.created_at, o.updated_at,
             o.contact_id, c.name as contact_name, c.username as contact_username, c.last_inbound_at, f.name as flow_name
      from autoflow.orders o
      left join autoflow.contacts c on c.id = o.contact_id
      left join autoflow.flows f on f.id = o.flow_id
      where o.workspace_id = ${wsOf(req)} ${status ? sql`and o.status = ${status}` : sql``}
      order by o.created_at desc
      limit 300`;
  });

  /** Para o aviso do painel: quantos pedidos novos e o número do último. */
  app.get('/app/orders/summary', async (req) => {
    const [r] = await sql`
      select count(*) filter (where status = 'new')::int as new_count, coalesce(max(number), 0)::int as last_number
      from autoflow.orders where workspace_id = ${wsOf(req)}`;
    return r;
  });

  app.patch('/app/orders/:id', async (req) => {
    const ws = wsOf(req);
    const id = idOf(req);
    const body = z.object({ status: z.enum(ORDER_STATUSES), notify: z.boolean().default(true) }).parse(req.body);
    const [o] = await sql`
      update autoflow.orders set status = ${body.status}, updated_at = now()
      where id = ${id} and workspace_id = ${ws}
      returning id, number, status, contact_id`;
    if (!o) throw new HttpError(404, 'Pedido não encontrado');

    let notified: boolean | null = null;
    let warning: string | null = null;
    const text = body.notify ? statusMessage(body.status, o.number as number) : null;
    if (text && o.contact_id) {
      notified = false;
      try {
        const contact = await store.getContact(o.contact_id as string);
        const account = contact ? await store.getAccountById(contact.igAccountId) : null;
        const last = contact?.lastInboundAt?.getTime() ?? 0;
        if (!contact || !account || account.status !== 'active') warning = 'A conta do Instagram não está conectada.';
        else if (Date.now() - last > 24 * 3600 * 1000)
          warning = 'Não deu para avisar o cliente: passaram mais de 24h desde a última mensagem dele.';
        else {
          const token = await store.getAccessToken(account.id);
          const res = await ig.sendMessage(token, account.pageId ?? account.igUserId, { id: contact.igsid }, { kind: 'text', text });
          await store.logMessage({ workspaceId: ws, contactId: contact.id, direction: 'out', source: 'bot', mid: res.messageId ?? null, text });
          notified = true;
        }
      } catch (err) {
        req.log.warn({ err, orderId: id }, 'Falha ao avisar o cliente do pedido');
        warning = `Não deu para avisar o cliente: ${(err as Error).message}`;
      }
    }
    return { ...o, notified, warning };
  });
}
