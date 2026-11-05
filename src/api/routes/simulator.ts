/**
 * Simulador: conversa com o robô como se fosse um cliente no Instagram, sem passar pela Meta.
 * Usa o motor de verdade com uma conta "simulada" por negócio (o envio não sai para a Meta).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { createEngine } from '../../engine/factory.js';
import { SIM_TOKEN, simFollowers } from '../../instagram/client.js';
import type { InboundEvent } from '../../instagram/webhook.js';
import { encrypt } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';
import { redis, tryLock } from '../../lib/redis.js';

export const simIds = (ws: string) => ({ igUserId: `sim_${ws}`, igsid: `sim_user_${ws}` });

async function ensureSimAccount(ws: string) {
  const sql = db();
  const { igUserId } = simIds(ws);
  const [acc] = await sql`
    insert into autoflow.ig_accounts (workspace_id, ig_user_id, username, name, account_type, status, hourly_send_limit)
    values (${ws}, ${igUserId}, 'simulador', 'Simulador', 'SIMULATOR', 'active', 100000)
    on conflict (ig_user_id) do update set status = 'active', updated_at = now()
    returning id`;
  await sql`
    insert into autoflow.ig_account_tokens (ig_account_id, access_token_enc, token_expires_at)
    values (${acc!.id}, ${encrypt(SIM_TOKEN, config().ENCRYPTION_KEY)}, null)
    on conflict (ig_account_id) do nothing`;
  return acc!.id as string;
}

export async function simulatorRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();
  let engine: ReturnType<typeof createEngine> | undefined;
  const getEngine = () => (engine ??= createEngine());

  async function state(ws: string) {
    const { igsid } = simIds(ws);
    const [c] = await sql`
      select c.*, coalesce(cf.values, '{}'::jsonb) as fields,
        coalesce((select array_agg(t.name order by t.name) from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id
                  where ct.contact_id = c.id), '{}') as tags
      from autoflow.contacts c left join autoflow.contact_fields cf on cf.contact_id = c.id
      where c.workspace_id = ${ws} and c.igsid = ${igsid}`;
    const follows = simFollowers.has(igsid);
    if (!c) return { contact: null, messages: [], session: null, follows };
    const messages = await sql`
      select id, direction, source, text, payload, created_at from autoflow.messages
      where contact_id = ${c.id} order by created_at, id limit 500`;
    const [session] = await sql`
      select s.status, s.current_node_id, f.name as flow_name from autoflow.sessions s join autoflow.flows f on f.id = s.flow_id
      where s.contact_id = ${c.id} order by s.started_at desc limit 1`;
    return {
      contact: { id: c.id, tags: c.tags, fields: c.fields, bot_paused_until: c.bot_paused_until },
      messages,
      session: session ?? null,
      follows,
    };
  }

  app.get('/app/simulator', async (req) => state(wsOf(req)));

  /** Marca se o "cliente" do simulador segue a conta (para testar a condição "Segue a conta"). */
  app.post('/app/simulator/follow', async (req) => {
    const ws = wsOf(req);
    const { follows } = z.object({ follows: z.boolean() }).parse(req.body);
    if (follows) simFollowers.add(simIds(ws).igsid);
    else simFollowers.delete(simIds(ws).igsid);
    return state(ws);
  });

  app.post('/app/simulator/reset', async (req) => {
    const ws = wsOf(req);
    simFollowers.delete(simIds(ws).igsid);
    await sql`delete from autoflow.contacts where workspace_id = ${ws} and igsid = ${simIds(ws).igsid}`;
    return state(ws);
  });

  app.post('/app/simulator/send', async (req) => {
    const ws = wsOf(req);
    const body = z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }),
        z.object({ type: z.literal('click'), payload: z.string().min(1), title: z.string().default('') }),
        z.object({ type: z.literal('quick_reply'), payload: z.string().min(1), title: z.string().default('') }),
        z.object({ type: z.literal('comment'), text: z.string().min(1).max(1000), media_id: z.string().optional() }),
        z.object({ type: z.literal('story_mention') }),
        z.object({ type: z.literal('story_reply'), text: z.string().min(1).max(1000) }),
        z.object({ type: z.literal('ref'), ref: z.string().trim().min(1).max(60) }),
        z.object({ type: z.literal('ad'), text: z.string().min(1).max(1000), ad_id: z.string().optional() }),
      ])
      .parse(req.body);

    await ensureSimAccount(ws);
    const { igUserId, igsid } = simIds(ws);
    const mid = `sim_in_${randomUUID()}`;
    const ts = Date.now();
    let event: InboundEvent;
    switch (body.type) {
      case 'text':
        event = { kind: 'dm', igUserId, senderId: igsid, mid, text: body.text, timestamp: ts };
        break;
      case 'quick_reply':
        event = { kind: 'dm', igUserId, senderId: igsid, mid, text: body.title, quickReplyPayload: body.payload, timestamp: ts };
        break;
      case 'click':
        event = { kind: 'postback', igUserId, senderId: igsid, mid, payload: body.payload, title: body.title, timestamp: ts };
        break;
      case 'comment':
        event = {
          kind: 'comment',
          igUserId,
          commentId: `sim_c_${randomUUID()}`,
          text: body.text,
          fromId: igsid,
          fromUsername: 'cliente.teste',
          mediaId: body.media_id || 'sim_media',
          timestamp: ts,
        };
        break;
      case 'story_mention':
        event = { kind: 'story_mention', igUserId, senderId: igsid, mid, url: undefined, timestamp: ts };
        break;
      case 'story_reply':
        event = { kind: 'dm', igUserId, senderId: igsid, mid, text: body.text, storyReply: { id: 'sim_story' }, timestamp: ts };
        break;
      case 'ref':
        event = { kind: 'referral', igUserId, senderId: igsid, mid, referral: { ref: body.ref, source: 'IGME_SOURCE_LINK' }, timestamp: ts };
        break;
      case 'ad':
        event = { kind: 'dm', igUserId, senderId: igsid, mid, text: body.text, referral: { source: 'ADS', adId: body.ad_id || undefined }, timestamp: ts };
        break;
    }

    // Mesmo lock do worker, para não processar junto com um atraso agendado
    const key = `af:lock:${igUserId}:${igsid}`;
    let release = await tryLock(redis(), key, 30_000);
    for (let i = 0; !release && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      release = await tryLock(redis(), key, 30_000);
    }
    try {
      await getEngine().handleEvent(event);
    } finally {
      await release?.();
    }
    return state(ws);
  });
}
