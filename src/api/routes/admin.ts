/**
 * API administrativa (protegida por x-api-key) — usada enquanto o painel não existe
 * e depois pelo próprio painel via backend.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { validateGraph, payload } from '../../flow/schema.js';
import { parseTriggerConfig, TriggerInputSchema } from '../../flow/triggers.js';
import { GraphIgClient } from '../../instagram/client.js';
import { safeEqual, signState } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';
import { PgStore } from '../../store/pg.js';

function requireKey(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !safeEqual(key, config().ADMIN_API_KEY)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

const uuid = z.string().uuid();

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireKey);
  const sql = db();

  // ── Workspaces ──
  app.post('/admin/workspaces', async (req) => {
    const body = z
      .object({ name: z.string().min(1), settings: z.record(z.unknown()).optional() })
      .parse(req.body);
    const [w] = await sql`
      insert into autoflow.workspaces (name, settings)
      values (${body.name}, ${sql.json((body.settings ?? { timezone: 'America/Sao_Paulo', bot_pause_hours: 12 }) as any)})
      returning *`;
    return w;
  });

  app.patch('/admin/workspaces/:id', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ name: z.string().optional(), settings: z.record(z.unknown()).optional() }).parse(req.body);
    const [w] = await sql`
      update autoflow.workspaces set
        name = coalesce(${body.name ?? null}, name),
        settings = settings || ${sql.json((body.settings ?? {}) as any)}
      where id = ${id} returning *`;
    return w;
  });

  /** Gera o link "Conectar Instagram" para enviar ao cliente (válido 7 dias). */
  app.post('/admin/workspaces/:id/connect-link', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const s = signState({ workspaceId: id }, config().STATE_SECRET, 7 * 24 * 3600);
    return { url: `${config().PUBLIC_BASE_URL}/auth/instagram/start?s=${s}` };
  });

  app.get('/admin/workspaces/:id/accounts', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return sql`
      select a.id, a.ig_user_id, a.username, a.status, a.hourly_send_limit, t.token_expires_at
      from autoflow.ig_accounts a left join autoflow.ig_account_tokens t on t.ig_account_id = a.id
      where a.workspace_id = ${id} order by a.connected_at`;
  });

  // ── Fluxos ──
  app.get('/admin/flows', async (req) => {
    const { workspace_id } = z.object({ workspace_id: uuid }).parse(req.query);
    return sql`
      select f.id, f.name, f.status, f.published_version_id, f.updated_at, v.version as published_version
      from autoflow.flows f left join autoflow.flow_versions v on v.id = f.published_version_id
      where f.workspace_id = ${workspace_id} order by f.updated_at desc`;
  });

  app.get('/admin/flows/:id', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const [f] = await sql`select * from autoflow.flows where id = ${id}`;
    return f ?? reply.code(404).send({ error: 'not found' });
  });

  app.post('/admin/flows', async (req) => {
    const body = z.object({ workspace_id: uuid, name: z.string().min(1), graph: z.unknown().optional() }).parse(req.body);
    const [f] = await sql`
      insert into autoflow.flows (workspace_id, name, draft_graph)
      values (${body.workspace_id}, ${body.name}, ${body.graph ? sql.json(body.graph as any) : null})
      returning *`;
    return f;
  });

  app.put('/admin/flows/:id', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z.object({ name: z.string().optional(), graph: z.unknown() }).parse(req.body);
    const [f] = await sql`
      update autoflow.flows set draft_graph = ${sql.json(body.graph as any)}, name = coalesce(${body.name ?? null}, name), updated_at = now()
      where id = ${id} returning *`;
    return f;
  });

  app.post('/admin/flows/:id/validate', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const [f] = await sql`select draft_graph from autoflow.flows where id = ${id}`;
    return { issues: validateGraph(f?.draft_graph).issues };
  });

  /** Publica o rascunho como nova versão imutável. Sessões em andamento continuam na versão antiga. */
  app.post('/admin/flows/:id/publish', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const [f] = await sql`select * from autoflow.flows where id = ${id}`;
    if (!f) return reply.code(404).send({ error: 'not found' });
    const { graph, issues } = validateGraph(f.draft_graph);
    if (!graph || issues.some((i) => i.level === 'error')) return reply.code(422).send({ issues });

    const version = await sql.begin(async (tx) => {
      const [v] = await tx`
        insert into autoflow.flow_versions (flow_id, version, graph)
        values (${id}, coalesce((select max(version) from autoflow.flow_versions where flow_id = ${id}), 0) + 1, ${tx.json(graph as any)})
        returning id, version`;
      await tx`update autoflow.flows set status = 'published', published_version_id = ${v!.id}, updated_at = now() where id = ${id}`;
      return v!;
    });
    return { version, warnings: issues };
  });

  app.post('/admin/flows/:id/archive', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    await sql`update autoflow.flows set status = 'archived', updated_at = now() where id = ${id}`;
    return { ok: true };
  });

  /** Métricas por nó: quantos passaram, cliques e mensagens enviadas. */
  app.get('/admin/flows/:id/stats', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const { days } = z.object({ days: z.coerce.number().default(30) }).parse(req.query);
    const totals = await sql`
      select type, count(*)::int as count from autoflow.events
      where flow_id = ${id} and created_at > now() - make_interval(days => ${days})
      group by type`;
    const nodes = await sql`
      select node_id, type, count(*)::int as count from autoflow.events
      where flow_id = ${id} and node_id is not null and created_at > now() - make_interval(days => ${days})
      group by node_id, type order by node_id`;
    return { totals, nodes };
  });

  // ── Gatilhos ──
  app.get('/admin/triggers', async (req) => {
    const { workspace_id } = z.object({ workspace_id: uuid }).parse(req.query);
    return sql`select * from autoflow.triggers where workspace_id = ${workspace_id} order by type, priority desc`;
  });

  app.post('/admin/triggers', async (req) => {
    const body = TriggerInputSchema.parse(req.body);
    const cfg = parseTriggerConfig(body.type, body.config);
    const [t] = await sql`
      insert into autoflow.triggers (workspace_id, ig_account_id, flow_id, type, config, priority, enabled)
      values (${body.workspace_id}, ${body.ig_account_id ?? null}, ${body.flow_id}, ${body.type},
              ${sql.json(cfg as any)}, ${body.priority}, ${body.enabled})
      returning *`;
    return { ...t, start_payload: payload.trigger(t!.id) };
  });

  app.patch('/admin/triggers/:id', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z
      .object({ config: z.record(z.unknown()).optional(), priority: z.number().int().optional(), enabled: z.boolean().optional() })
      .parse(req.body);
    const [cur] = await sql`select * from autoflow.triggers where id = ${id}`;
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const cfg = body.config ? parseTriggerConfig(cur.type, body.config) : cur.config;
    const [t] = await sql`
      update autoflow.triggers set config = ${sql.json(cfg)}, priority = ${body.priority ?? cur.priority},
        enabled = ${body.enabled ?? cur.enabled}
      where id = ${id} returning *`;
    return t;
  });

  app.delete('/admin/triggers/:id', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    await sql`delete from autoflow.triggers where id = ${id}`;
    return { ok: true };
  });

  // ── Conta: ice breakers ──
  app.post('/admin/accounts/:id/ice-breakers', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const body = z
      .object({ items: z.array(z.object({ question: z.string().min(1).max(80), trigger_id: uuid })).min(1).max(4) })
      .parse(req.body);
    const store = new PgStore(sql);
    const token = await store.getAccessToken(id);
    return new GraphIgClient().setIceBreakers(
      token,
      body.items.map((i) => ({ question: i.question, payload: payload.trigger(i.trigger_id) })),
    );
  });

  // ── Contatos e inbox ──
  app.get('/admin/contacts', async (req) => {
    const q = z
      .object({ workspace_id: uuid, tag: z.string().optional(), limit: z.coerce.number().max(500).default(100) })
      .parse(req.query);
    return sql`
      select c.*, coalesce(cf.values, '{}'::jsonb) as fields,
        coalesce(array_agg(t.name) filter (where t.name is not null), '{}') as tags
      from autoflow.contacts c
      left join autoflow.contact_fields cf on cf.contact_id = c.id
      left join autoflow.contact_tags ct on ct.contact_id = c.id
      left join autoflow.tags t on t.id = ct.tag_id
      where c.workspace_id = ${q.workspace_id}
      group by c.id, cf.values
      ${q.tag ? sql`having ${q.tag} = any(array_agg(t.name))` : sql``}
      order by c.updated_at desc limit ${q.limit}`;
  });

  app.get('/admin/contacts/:id/messages', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    return sql`select * from autoflow.messages where contact_id = ${id} order by created_at desc limit 200`;
  });

  /** Reativa o robô para um contato (depois de um atendimento humano). */
  app.post('/admin/contacts/:id/resume-bot', async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    await sql`update autoflow.contacts set bot_paused_until = null, updated_at = now() where id = ${id}`;
    return { ok: true };
  });
}
