/**
 * API do painel (/app/*): autenticada com o token do Supabase Auth do usuário.
 * Rotas de workspace exigem o header `x-workspace-id` e que o usuário seja membro.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { payload, validateGraph } from '../../flow/schema.js';
import { parseTriggerConfig, TriggerConfigSchemas } from '../../flow/triggers.js';
import { GraphIgClient } from '../../instagram/client.js';
import { instagramConnectUrl } from '../../instagram/oauth.js';
import { signState } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';
import { PgStore } from '../../store/pg.js';
import { HttpError } from '../http.js';
import { postRoutes } from './posts.js';
import { simulatorRoutes } from './simulator.js';

export interface AuthUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    workspaceId?: string;
  }
}


// ── Verificação do token do Supabase (com cache curto) ──
const cache = new Map<string, { user: AuthUser; until: number }>();

export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

export const supabaseVerifier: TokenVerifier = async (token) => {
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = config();
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new HttpError(503, 'SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY não configurados no .env');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as { id: string; email: string };
  const user = { id: u.id, email: u.email };
  cache.set(token, { user, until: Date.now() + 60_000 });
  if (cache.size > 5000) cache.clear();
  return user;
};

const uuid = z.string().uuid();
const idParam = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

function loadTemplates() {
  const dir = join(process.cwd(), 'templates');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        name: string;
        description?: string;
        flow: unknown;
        triggers?: { type: keyof typeof TriggerConfigSchemas; priority: number; config: unknown }[];
      };
      return { id: f.replace(/\.json$/, ''), ...t };
    });
}

export async function appRoutes(app: FastifyInstance, opts: { verifyToken?: TokenVerifier } = {}) {
  const verify = opts.verifyToken ?? supabaseVerifier;
  const sql = db();
  const store = new PgStore(sql);
  const ig = new GraphIgClient();

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Dados inválidos', issues: err.issues });
    // Erros do próprio Fastify (corpo grande demais, tipo não aceito…) mantêm o status 4xx
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const msg = status === 415 ? 'Formato não aceito. Use imagem JPG ou vídeo MP4/MOV.' : (err as Error).message;
      return reply.code(status).send({ error: msg });
    }
    req.log.error({ err }, 'Erro na API do painel');
    const msg = (err as Error).message;
    return reply.code(500).send({ error: msg || 'Erro interno' });
  });

  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Faça login');
    const user = await verify(h.slice(7));
    if (!user) throw new HttpError(401, 'Sessão expirada, faça login de novo');
    req.user = user;

    const ws = req.headers['x-workspace-id'];
    if (typeof ws === 'string' && ws) {
      const [m] = await sql`
        select 1 from autoflow.workspace_members where workspace_id = ${uuid.parse(ws)} and user_id = ${user.id}`;
      if (!m) throw new HttpError(403, 'Você não tem acesso a este workspace');
      req.workspaceId = ws;
    }
  });

  const wsOf = (req: FastifyRequest) => {
    if (!req.workspaceId) throw new HttpError(400, 'Selecione um workspace');
    return req.workspaceId;
  };

  /** Garante que um registro pertence ao workspace atual. */
  async function own(table: 'flows' | 'triggers' | 'contacts' | 'ig_accounts', id: string, ws: string) {
    const rows = await sql`select 1 from ${sql('autoflow.' + table)} where id = ${id} and workspace_id = ${ws}`;
    if (!rows.length) throw new HttpError(404, 'Não encontrado');
  }

  await simulatorRoutes(app, wsOf);
  await postRoutes(app, wsOf);

  // ───────────── Usuário e workspaces ─────────────
  app.get('/app/me', async (req) => {
    const workspaces = await sql`
      select w.id, w.name, w.settings, m.role from autoflow.workspaces w
      join autoflow.workspace_members m on m.workspace_id = w.id
      where m.user_id = ${req.user!.id} order by w.created_at`;
    return { user: req.user, workspaces };
  });

  app.post('/app/workspaces', async (req) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    return sql.begin(async (tx) => {
      const [w] = await tx`
        insert into autoflow.workspaces (name, settings)
        values (${body.name}, ${tx.json({ timezone: 'America/Sao_Paulo', bot_pause_hours: 12 })}) returning id, name, settings`;
      await tx`insert into autoflow.workspace_members (workspace_id, user_id, role) values (${w!.id}, ${req.user!.id}, 'owner')`;
      return w;
    });
  });

  app.get('/app/workspace', async (req) => {
    const [w] = await sql`select id, name, settings from autoflow.workspaces where id = ${wsOf(req)}`;
    return w;
  });

  app.patch('/app/workspace', async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        settings: z
          .object({
            timezone: z.string().optional(),
            bot_pause_hours: z.number().min(0).max(168).optional(),
            business_hours: z.record(z.array(z.tuple([z.string(), z.string()]))).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const [w] = await sql`
      update autoflow.workspaces set
        name = coalesce(${body.name ?? null}, name),
        settings = settings || ${sql.json((body.settings ?? {}) as any)}
      where id = ${wsOf(req)} returning id, name, settings`;
    return w;
  });

  // ───────────── Painel inicial ─────────────
  app.get('/app/overview', async (req) => {
    const ws = wsOf(req);
    const [c] = await sql`
      select
        (select count(*)::int from autoflow.contacts where workspace_id = ${ws} and igsid not like 'sim\_%') as contacts,
        (select count(*)::int from autoflow.contacts where workspace_id = ${ws} and igsid not like 'sim\_%' and created_at > now() - interval '7 days') as new_contacts_7d,
        (select count(*)::int from autoflow.messages where workspace_id = ${ws} and contact_id not in (select id from autoflow.contacts where igsid like 'sim\_%') and direction = 'in' and created_at > now() - interval '7 days') as messages_in_7d,
        (select count(*)::int from autoflow.messages where workspace_id = ${ws} and contact_id not in (select id from autoflow.contacts where igsid like 'sim\_%') and source = 'bot' and created_at > now() - interval '7 days') as messages_bot_7d,
        (select count(*)::int from autoflow.events where workspace_id = ${ws} and contact_id not in (select id from autoflow.contacts where igsid like 'sim\_%') and type = 'flow_started' and created_at > now() - interval '7 days') as flows_started_7d,
        (select count(*)::int from autoflow.events where workspace_id = ${ws} and contact_id not in (select id from autoflow.contacts where igsid like 'sim\_%') and type = 'flow_completed' and created_at > now() - interval '7 days') as flows_completed_7d,
        (select count(*)::int from autoflow.contacts where workspace_id = ${ws} and bot_paused_until > now()) as waiting_human,
        (select count(*)::int from autoflow.ig_accounts where workspace_id = ${ws} and status = 'active' and account_type is distinct from 'SIMULATOR') as accounts`;
    const daily = await sql`
      select to_char(d, 'YYYY-MM-DD') as day,
        (select count(*)::int from autoflow.messages m where m.workspace_id = ${ws} and m.direction = 'in' and m.contact_id not in (select id from autoflow.contacts where igsid like 'sim\_%')
           and m.created_at >= d and m.created_at < d + interval '1 day') as messages_in,
        (select count(*)::int from autoflow.events e where e.workspace_id = ${ws} and e.type = 'flow_started' and coalesce(e.contact_id::text,'') not in (select id::text from autoflow.contacts where igsid like 'sim\_%')
           and e.created_at >= d and e.created_at < d + interval '1 day') as flows_started
      from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
      order by d`;
    return { ...c, daily };
  });

  // ───────────── Contas do Instagram ─────────────
  app.get('/app/accounts', async (req) => {
    return sql`
      select a.id, a.ig_user_id, a.username, a.name, a.profile_picture_url, a.status, a.hourly_send_limit,
             a.connected_at, t.token_expires_at
      from autoflow.ig_accounts a left join autoflow.ig_account_tokens t on t.ig_account_id = a.id
      where a.workspace_id = ${wsOf(req)} and a.account_type is distinct from 'SIMULATOR' order by a.connected_at`;
  });

  app.post('/app/connect-link', async (req) => {
    const s = signState({ workspaceId: wsOf(req) }, config().STATE_SECRET, 7 * 24 * 3600);
    return { url: instagramConnectUrl(s) };
  });

  app.get('/app/accounts/:id/media', async (req) => {
    const id = idParam(req);
    await own('ig_accounts', id, wsOf(req));
    const acc = await store.getAccountById(id);
    const token = await store.getAccessToken(id);
    const res = await ig.getMedia(token, acc!.igUserId);
    return res.data;
  });

  app.delete('/app/accounts/:id', async (req) => {
    const id = idParam(req);
    await own('ig_accounts', id, wsOf(req));
    await sql`update autoflow.ig_accounts set status = 'disconnected', updated_at = now() where id = ${id}`;
    return { ok: true };
  });

  // ───────────── Templates e fluxos ─────────────
  app.get('/app/templates', async () =>
    loadTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description ?? '' })),
  );

  app.get('/app/flows', async (req) => {
    return sql`
      select f.id, f.name, f.status, f.updated_at, v.version as published_version,
        (select count(*)::int from autoflow.triggers t where t.flow_id = f.id and t.enabled) as triggers,
        (select count(*)::int from autoflow.events e where e.flow_id = f.id and e.type = 'flow_started'
           and e.created_at > now() - interval '30 days') as started_30d,
        (select count(*)::int from autoflow.events e where e.flow_id = f.id and e.type = 'flow_completed'
           and e.created_at > now() - interval '30 days') as completed_30d
      from autoflow.flows f left join autoflow.flow_versions v on v.id = f.published_version_id
      where f.workspace_id = ${wsOf(req)} and f.status <> 'archived'
      order by f.updated_at desc`;
  });

  app.post('/app/flows', async (req) => {
    const ws = wsOf(req);
    const body = z
      .object({ name: z.string().min(1).max(100), template_id: z.string().optional(), create_triggers: z.boolean().default(false) })
      .parse(req.body);
    let graph: unknown = {
      start: 'inicio',
      nodes: { inicio: { type: 'message', data: { text: 'Oi, {{first_name|tudo bem}}! 👋' }, next: null } },
    };
    let tplTriggers: ReturnType<typeof loadTemplates>[number]['triggers'] = [];
    if (body.template_id) {
      const t = loadTemplates().find((x) => x.id === body.template_id);
      if (!t) throw new HttpError(404, 'Template não encontrado');
      graph = t.flow;
      tplTriggers = t.triggers ?? [];
    }
    return sql.begin(async (tx) => {
      const [f] = await tx`
        insert into autoflow.flows (workspace_id, name, draft_graph)
        values (${ws}, ${body.name}, ${tx.json(graph as any)}) returning id, name, status`;
      if (body.create_triggers) {
        for (const t of tplTriggers ?? []) {
          await tx`
            insert into autoflow.triggers (workspace_id, flow_id, type, config, priority)
            values (${ws}, ${f!.id}, ${t.type}, ${tx.json(parseTriggerConfig(t.type, t.config) as any)}, ${t.priority})`;
        }
      }
      return f;
    });
  });

  app.get('/app/flows/:id', async (req) => {
    const id = idParam(req);
    await own('flows', id, wsOf(req));
    const [f] = await sql`
      select f.*, v.version as published_version, v.graph as published_graph
      from autoflow.flows f left join autoflow.flow_versions v on v.id = f.published_version_id where f.id = ${id}`;
    return { ...f, issues: validateGraph(f!.draft_graph).issues };
  });

  app.put('/app/flows/:id', async (req) => {
    const id = idParam(req);
    await own('flows', id, wsOf(req));
    const body = z.object({ name: z.string().min(1).max(100).optional(), graph: z.unknown().optional() }).parse(req.body);
    const [f] = await sql`
      update autoflow.flows set
        name = coalesce(${body.name ?? null}, name),
        draft_graph = coalesce(${body.graph === undefined ? null : sql.json(body.graph as any)}, draft_graph),
        updated_at = now()
      where id = ${id} returning id, name, status, draft_graph, updated_at`;
    return { ...f, issues: validateGraph(f!.draft_graph).issues };
  });

  app.post('/app/flows/:id/publish', async (req, reply) => {
    const id = idParam(req);
    await own('flows', id, wsOf(req));
    const [f] = await sql`select draft_graph from autoflow.flows where id = ${id}`;
    const { graph, issues } = validateGraph(f!.draft_graph);
    if (!graph || issues.some((i) => i.level === 'error')) return reply.code(422).send({ error: 'O fluxo tem erros', issues });
    const version = await sql.begin(async (tx) => {
      const [v] = await tx`
        insert into autoflow.flow_versions (flow_id, version, graph)
        values (${id}, coalesce((select max(version) from autoflow.flow_versions where flow_id = ${id}), 0) + 1, ${tx.json(graph as any)})
        returning id, version`;
      await tx`update autoflow.flows set status = 'published', published_version_id = ${v!.id}, updated_at = now() where id = ${id}`;
      return v!;
    });
    return { version, issues };
  });

  app.post('/app/flows/:id/duplicate', async (req) => {
    const id = idParam(req);
    const ws = wsOf(req);
    await own('flows', id, ws);
    const [f] = await sql`
      insert into autoflow.flows (workspace_id, name, draft_graph)
      select workspace_id, name || ' (cópia)', draft_graph from autoflow.flows where id = ${id}
      returning id, name, status`;
    return f;
  });

  app.delete('/app/flows/:id', async (req) => {
    const id = idParam(req);
    await own('flows', id, wsOf(req));
    await sql`update autoflow.flows set status = 'archived', updated_at = now() where id = ${id}`;
    await sql`update autoflow.triggers set enabled = false where flow_id = ${id}`;
    return { ok: true };
  });

  app.get('/app/flows/:id/stats', async (req) => {
    const id = idParam(req);
    await own('flows', id, wsOf(req));
    const { days } = z.object({ days: z.coerce.number().min(1).max(365).default(30) }).parse(req.query);
    const totals = await sql`
      select type, count(*)::int as count from autoflow.events
      where flow_id = ${id} and created_at > now() - make_interval(days => ${days}) group by type`;
    const nodes = await sql`
      select node_id, type, count(*)::int as count from autoflow.events
      where flow_id = ${id} and node_id is not null and created_at > now() - make_interval(days => ${days})
      group by node_id, type`;
    return { totals, nodes };
  });

  // ───────────── Gatilhos ─────────────
  const TriggerBody = z.object({
    flow_id: uuid,
    ig_account_id: uuid.nullable().optional(),
    type: z.enum(['comment', 'dm_keyword', 'story_mention', 'story_reply', 'ref_link', 'ad_click', 'postback', 'default_reply']),
    config: z.record(z.unknown()).default({}),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
  });

  app.get('/app/triggers', async (req) => {
    return sql`
      select t.*, f.name as flow_name, f.status as flow_status from autoflow.triggers t
      join autoflow.flows f on f.id = t.flow_id
      where t.workspace_id = ${wsOf(req)} and f.status <> 'archived'
      order by t.type, t.priority desc, t.created_at`;
  });

  app.post('/app/triggers', async (req) => {
    const ws = wsOf(req);
    const body = TriggerBody.parse(req.body);
    await own('flows', body.flow_id, ws);
    const cfg = parseTriggerConfig(body.type, body.config);
    const [t] = await sql`
      insert into autoflow.triggers (workspace_id, ig_account_id, flow_id, type, config, priority, enabled)
      values (${ws}, ${body.ig_account_id ?? null}, ${body.flow_id}, ${body.type}, ${sql.json(cfg as any)}, ${body.priority}, ${body.enabled})
      returning *`;
    return { ...t, start_payload: payload.trigger(t!.id) };
  });

  app.put('/app/triggers/:id', async (req) => {
    const id = idParam(req);
    const ws = wsOf(req);
    await own('triggers', id, ws);
    const body = TriggerBody.parse(req.body);
    await own('flows', body.flow_id, ws);
    const cfg = parseTriggerConfig(body.type, body.config);
    const [t] = await sql`
      update autoflow.triggers set flow_id = ${body.flow_id}, ig_account_id = ${body.ig_account_id ?? null}, type = ${body.type},
        config = ${sql.json(cfg as any)}, priority = ${body.priority}, enabled = ${body.enabled}
      where id = ${id} returning *`;
    return t;
  });

  app.delete('/app/triggers/:id', async (req) => {
    const id = idParam(req);
    await own('triggers', id, wsOf(req));
    await sql`delete from autoflow.triggers where id = ${id}`;
    return { ok: true };
  });

  // ───────────── Contatos e inbox ─────────────
  app.get('/app/contacts', async (req) => {
    const q = z
      .object({ q: z.string().optional(), tag: z.string().optional(), limit: z.coerce.number().min(1).max(500).default(100) })
      .parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`
      select c.id, c.igsid, c.username, c.name, c.last_inbound_at, c.bot_paused_until, c.created_at, c.updated_at,
        coalesce(cf.values, '{}'::jsonb) as fields,
        coalesce((select array_agg(t.name order by t.name) from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id
                  where ct.contact_id = c.id), '{}') as tags
      from autoflow.contacts c left join autoflow.contact_fields cf on cf.contact_id = c.id
      where c.workspace_id = ${wsOf(req)} and c.igsid not like 'sim\_%'
        ${like ? sql`and (c.username ilike ${like} or c.name ilike ${like})` : sql``}
        ${q.tag ? sql`and exists (select 1 from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id
                                  where ct.contact_id = c.id and t.name = ${q.tag})` : sql``}
      order by c.updated_at desc limit ${q.limit}`;
  });

  app.get('/app/tags', async (req) => {
    return sql`
      select t.name, count(ct.contact_id)::int as contacts from autoflow.tags t
      left join autoflow.contact_tags ct on ct.tag_id = t.id
      where t.workspace_id = ${wsOf(req)} group by t.name order by t.name`;
  });

  /** Conversas: último recado de cada contato */
  app.get('/app/conversations', async (req) => {
    const { filter } = z.object({ filter: z.enum(['all', 'human']).default('all') }).parse(req.query);
    return sql`
      select c.id, c.username, c.name, c.bot_paused_until, c.last_inbound_at,
        m.text as last_text, m.direction as last_direction, m.source as last_source, m.created_at as last_at
      from autoflow.contacts c
      join lateral (
        select text, direction, source, created_at from autoflow.messages
        where contact_id = c.id order by created_at desc limit 1
      ) m on true
      where c.workspace_id = ${wsOf(req)} and c.igsid not like 'sim\_%'
        ${filter === 'human' ? sql`and c.bot_paused_until > now()` : sql``}
      order by m.created_at desc limit 200`;
  });

  app.get('/app/contacts/:id', async (req) => {
    const id = idParam(req);
    await own('contacts', id, wsOf(req));
    const [c] = await sql`
      select c.*, coalesce(cf.values, '{}'::jsonb) as fields,
        coalesce((select array_agg(t.name order by t.name) from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id
                  where ct.contact_id = c.id), '{}') as tags
      from autoflow.contacts c left join autoflow.contact_fields cf on cf.contact_id = c.id where c.id = ${id}`;
    const messages = await sql`
      select id, direction, source, text, payload, created_at from autoflow.messages
      where contact_id = ${id} order by created_at desc limit 200`;
    return { ...c, messages: messages.reverse() };
  });

  /** Atendente responde pela inbox (pausa o robô para esse contato). */
  app.post('/app/contacts/:id/messages', async (req) => {
    const id = idParam(req);
    const ws = wsOf(req);
    await own('contacts', id, ws);
    const { text } = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    const contact = (await store.getContact(id))!;
    const account = await store.getAccountById(contact.igAccountId);
    if (!account || account.status !== 'active') throw new HttpError(409, 'A conta do Instagram não está conectada');
    const last = contact.lastInboundAt?.getTime() ?? 0;
    if (Date.now() - last > 24 * 3600 * 1000)
      throw new HttpError(409, 'Passaram mais de 24h desde a última mensagem do cliente — o Instagram não permite responder agora.');
    const token = await store.getAccessToken(account.id);
    const res = await ig.sendMessage(token, account.pageId ?? account.igUserId, { id: contact.igsid }, { kind: 'text', text });
    await store.logMessage({ workspaceId: ws, contactId: id, direction: 'out', source: 'human', mid: res.messageId ?? null, text });
    const hours = account.settings.bot_pause_hours ?? 12;
    if (hours > 0) {
      await store.updateContact(id, { botPausedUntil: new Date(Date.now() + hours * 3_600_000) });
      await store.cancelActiveSessions(id);
    }
    return { ok: true };
  });

  app.post('/app/contacts/:id/pause-bot', async (req) => {
    const id = idParam(req);
    await own('contacts', id, wsOf(req));
    const { hours } = z.object({ hours: z.number().min(1).max(168).default(12) }).parse(req.body ?? {});
    await sql`update autoflow.contacts set bot_paused_until = now() + make_interval(hours => ${hours}), updated_at = now() where id = ${id}`;
    await store.cancelActiveSessions(id);
    return { ok: true };
  });

  app.post('/app/contacts/:id/resume-bot', async (req) => {
    const id = idParam(req);
    await own('contacts', id, wsOf(req));
    await sql`update autoflow.contacts set bot_paused_until = null, updated_at = now() where id = ${id}`;
    return { ok: true };
  });

  app.post('/app/contacts/:id/tags', async (req) => {
    const id = idParam(req);
    const ws = wsOf(req);
    await own('contacts', id, ws);
    const { tag, remove } = z.object({ tag: z.string().min(1).max(50), remove: z.boolean().default(false) }).parse(req.body);
    if (remove) await store.removeTag(ws, id, tag);
    else await store.addTag(ws, id, tag);
    return { ok: true };
  });
}
