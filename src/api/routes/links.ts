/**
 * Links rastreados: PUBLIC_BASE_URL/r/<code> → conta o clique, roda as ações do botão (tag, campo) e redireciona.
 * Público (quem clica é o cliente no Instagram). Se algo falhar ao registrar, redireciona mesmo assim.
 */
import type { FastifyInstance } from 'fastify';
import { applyButtonActions } from '../../engine/engine.js';
import { ButtonActionSchema } from '../../flow/schema.js';
import { db } from '../../lib/db.js';
import { LINK_CODE_RE } from '../../lib/links.js';
import { logger } from '../../lib/logger.js';
import { PgStore } from '../../store/pg.js';

export async function linkRoutes(app: FastifyInstance) {
  const sql = db();
  const store = new PgStore(sql);

  app.get('/r/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!LINK_CODE_RE.test(code)) return reply.code(404).type('text/html').send(notFound);
    const [l] = await sql`
      update autoflow.links set clicks = clicks + 1, last_clicked_at = now(), first_clicked_at = coalesce(first_clicked_at, now())
      where code = ${code}
      returning workspace_id, flow_id, node_id, contact_id, url, actions, clicks`;
    if (!l) return reply.code(404).type('text/html').send(notFound);

    // Registro e ações não podem atrasar nem impedir a abertura do link
    void (async () => {
      try {
        await store.logEvent({
          workspaceId: l.workspace_id as string,
          contactId: (l.contact_id as string | null) ?? null,
          flowId: (l.flow_id as string | null) ?? null,
          nodeId: (l.node_id as string | null) ?? null,
          type: 'link_clicked',
          data: { code, first: l.clicks === 1 },
        });
        const actions = ButtonActionSchema.array().safeParse(l.actions ?? []);
        if (l.clicks === 1 && l.contact_id && actions.success && actions.data.length) {
          const contact = await store.getContact(l.contact_id as string);
          if (contact) await applyButtonActions(store, l.workspace_id as string, contact, actions.data, new Date());
        }
      } catch (err) {
        logger.warn({ err, code }, 'Falha ao registrar clique');
      }
    })();

    return reply.code(302).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(l.url as string);
  });
}

const notFound = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link não encontrado</title><body style="font:16px system-ui;padding:40px;text-align:center;color:#333">
<h2>Link não encontrado</h2><p>Esse link expirou ou foi digitado errado.</p></body>`;
