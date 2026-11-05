import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { dedupeKey, normalizeWebhook, verifySignature } from '../../instagram/webhook.js';
import { db } from '../../lib/db.js';
import { enqueueInbound } from '../../queue/queues.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Verificação do endpoint (configuração do webhook no painel da Meta)
  app.get('/webhooks/instagram', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config().IG_WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.code(403).send('forbidden');
  });

  app.post('/webhooks/instagram', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const secrets = [config().IG_APP_SECRET, ...config().IG_EXTRA_APP_SECRETS.split(',').map((s) => s.trim()).filter(Boolean)];
    if (!raw || !secrets.some((s) => verifySignature(raw, sig, s))) {
      req.log.warn('Webhook com assinatura inválida');
      return reply.code(401).send('invalid signature');
    }

    const events = normalizeWebhook(req.body);
    const sql = db();
    for (const event of events) {
      const key = dedupeKey(event);
      // Dedupe: a Meta reenvia eventos; só enfileira o que é novo
      const inserted = await sql`
        insert into autoflow.webhook_events (dedupe_key, ig_user_id, kind, raw)
        values (${key}, ${event.igUserId}, ${event.kind}, ${sql.json(event as any)})
        on conflict (dedupe_key) do nothing
        returning id`;
      if (!inserted.length) continue;
      try {
        await enqueueInbound(event, key);
      } catch (err) {
        // Sem fila: desfaz o dedupe e devolve erro para a Meta reenviar
        await sql`delete from autoflow.webhook_events where dedupe_key = ${key}`;
        req.log.error({ err }, 'Falha ao enfileirar webhook');
        return reply.code(500).send('queue unavailable');
      }
    }
    // Responder rápido: a Meta desativa webhooks que demoram/falham muito
    return reply.code(200).send('EVENT_RECEIVED');
  });
}
