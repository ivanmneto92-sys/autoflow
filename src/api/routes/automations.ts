/**
 * Automação rápida "Comentário → Direct": cria o fluxo pronto (publicado) e liga no post escolhido.
 * O resultado é um fluxo normal — dá para abrir no editor e ajustar depois.
 * As respostas do assistente ficam guardadas no próprio fluxo (graph.quick), para editar a automação
 * ou usá-la como base de outro post sem digitar tudo de novo.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCommentFlow, QuickCommentSchema } from '../../flow/quick.js';
import { validateGraph, type FlowGraph } from '../../flow/schema.js';
import { parseTriggerConfig } from '../../flow/triggers.js';
import { db } from '../../lib/db.js';
import { HttpError } from '../http.js';

const Body = QuickCommentSchema.extend({
  // Onde vale: qualquer post, um post já publicado, um post agendado no autoflow — ou "none" (só cria o fluxo)
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('any') }),
    z.object({ kind: z.literal('media'), media_id: z.string().regex(/^\d+$/) }),
    z.object({ kind: z.literal('scheduled'), post_id: z.string().uuid() }),
    z.object({ kind: z.literal('none') }),
  ]),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  match: z.enum(['contains', 'exact', 'starts_with']).default('contains'),
  public_replies: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  once_per_contact: z.boolean().default(true),
  // Editar uma automação que já existe (mesmo fluxo, nova versão) em vez de criar outra
  flow_id: z.string().uuid().optional(),
});
type BodyT = z.infer<typeof Body>;

/** Primeira linha da legenda, curta, para dar nome ao fluxo. */
function captionTitle(caption: string | null | undefined, mediaType: string): string {
  const first = (caption ?? '').split('\n')[0]!.trim();
  if (first) return first.length > 48 ? `${first.slice(0, 46)}…` : first;
  return mediaType === 'REELS' ? 'Reels sem legenda' : mediaType === 'CAROUSEL' ? 'Carrossel sem legenda' : 'Post sem legenda';
}

/** O que vai guardado no fluxo: tudo o que o assistente pergunta, menos onde vale e o nome. */
function quickConfig(b: BodyT) {
  const { target: _t, name: _n, flow_id: _f, ...rest } = b;
  return rest;
}

/** JSON com chaves ordenadas, para comparar grafos. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val));

export async function automationRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();

  /** Automações feitas pelo assistente, da mais recente para a mais antiga (para "Copiar de outro post"). */
  app.get('/app/automations/comment-dm', async (req) => {
    const rows = await sql`
      select f.id, f.name, f.updated_at, f.draft_graph->'quick' as quick,
        (select json_build_object('caption', p.caption, 'media_type', p.media_type, 'scheduled_at', p.scheduled_at, 'status', p.status,
                                  'thumb', p.media->0->>'url')
           from autoflow.scheduled_posts p where (p.automation->>'flow_id')::uuid = f.id order by p.scheduled_at desc limit 1) as post
      from autoflow.flows f
      where f.workspace_id = ${wsOf(req)} and f.status <> 'archived' and f.draft_graph ? 'quick'
      order by f.updated_at desc limit 40`;
    return rows.map((r) => ({
      flow_id: r.id,
      name: r.name,
      updated_at: r.updated_at,
      quick: r.quick,
      post: r.post ? { ...r.post, title: captionTitle(r.post.caption, r.post.media_type) } : null,
    }));
  });

  /** Uma automação para editar. `edited`: o fluxo foi mudado no editor depois (salvar aqui substitui essas mudanças). */
  app.get('/app/automations/comment-dm/:flowId', async (req) => {
    const flowId = z.string().uuid().parse((req.params as { flowId: string }).flowId);
    const [f] = await sql`select id, name, draft_graph from autoflow.flows where id = ${flowId} and workspace_id = ${wsOf(req)}`;
    if (!f) throw new HttpError(404, 'Fluxo não encontrado');
    const g = f.draft_graph as FlowGraph;
    if (!g.quick) return { flow_id: f.id, name: f.name, quick: null, edited: true };
    const parsed = Body.safeParse({ ...g.quick, target: { kind: 'none' } });
    let edited = true;
    if (parsed.success) {
      const rebuilt = buildCommentFlow(parsed.data).graph;
      edited = stable({ s: rebuilt.start, n: rebuilt.nodes }) !== stable({ s: g.start, n: g.nodes });
    }
    return { flow_id: f.id, name: f.name, quick: g.quick, edited };
  });

  app.post('/app/automations/comment-dm', async (req) => {
    const ws = wsOf(req);
    const b = Body.parse(req.body);
    const { graph: built, notes } = buildCommentFlow(b);
    const { graph: valid, issues } = validateGraph({ ...built, quick: quickConfig(b) });
    const errors = issues.filter((i) => i.level === 'error');
    if (!valid || errors.length) throw new HttpError(400, errors.map((e) => e.message.replace(/^nodes\.[^.]+\.data\./, '')).join('; '));

    const keywords = b.keywords.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean);
    const automation = { keywords, match: b.match, public_replies: b.public_replies, once_per_contact: b.once_per_contact };

    return sql.begin(async (tx) => {
      let post: { id: string; caption: string; media_type: string; trigger_id: string | null } | undefined;
      if (b.target.kind === 'scheduled') {
        // Na edição vale também para post já publicado (atualiza o gatilho dele)
        const [p] = await tx`
          select id, caption, media_type, trigger_id from autoflow.scheduled_posts where id = ${b.target.post_id} and workspace_id = ${ws}
            and status in ('scheduled', 'failed', 'cancelled' ${b.flow_id ? tx`, 'published'` : tx``}) for update`;
        if (!p) throw new HttpError(409, 'Essa publicação já saiu ou não existe. Escolha "Um post já publicado".');
        post = p as typeof post;
      }
      const auto = keywords.length ? ` (${keywords.slice(0, 2).join(', ')})` : '';
      const name = (b.name?.trim() || (post ? `Comentário → Direct · ${captionTitle(post.caption, post.media_type)}` : `Comentário → Direct${auto}`)).slice(0, 100);

      let flowId: string;
      let finalName = name;
      if (b.flow_id) {
        const [f] = await tx`select id, name from autoflow.flows where id = ${b.flow_id} and workspace_id = ${ws} for update`;
        if (!f) throw new HttpError(404, 'Fluxo não encontrado');
        flowId = f.id as string;
        if (!b.name?.trim()) finalName = f.name as string; // na edição o nome só muda se vier um novo
        const [{ next }] = (await tx`select coalesce(max(version), 0) + 1 as next from autoflow.flow_versions where flow_id = ${flowId}`) as any;
        const [v] = await tx`insert into autoflow.flow_versions (flow_id, version, graph) values (${flowId}, ${next}, ${tx.json(valid as any)}) returning id`;
        await tx`
          update autoflow.flows set draft_graph = ${tx.json(valid as any)}, status = 'published', published_version_id = ${v!.id},
            ${b.name?.trim() ? tx`name = ${name},` : tx``} updated_at = now()
          where id = ${flowId}`;
      } else {
        const [f] = await tx`
          insert into autoflow.flows (workspace_id, name, draft_graph) values (${ws}, ${name}, ${tx.json(valid as any)}) returning id`;
        flowId = f!.id as string;
        const [v] = await tx`insert into autoflow.flow_versions (flow_id, version, graph) values (${flowId}, 1, ${tx.json(valid as any)}) returning id`;
        await tx`update autoflow.flows set status = 'published', published_version_id = ${v!.id} where id = ${flowId}`;
      }

      let triggerId: string | null = null;
      if (b.target.kind === 'any' || b.target.kind === 'media') {
        const cfg = parseTriggerConfig('comment', { media_id: b.target.kind === 'media' ? b.target.media_id : null, ...automation });
        const [t] = await tx`
          insert into autoflow.triggers (workspace_id, flow_id, type, config, priority)
          values (${ws}, ${flowId}, 'comment', ${tx.json(cfg as any)}, ${b.target.kind === 'media' ? 10 : 0}) returning id`;
        triggerId = t!.id as string;
      } else if (post) {
        await tx`
          update autoflow.scheduled_posts set automation = ${tx.json({ flow_id: flowId, ...automation } as any)}, updated_at = now()
          where id = ${post.id}`;
        // Post já publicado: o gatilho dele passa a usar as palavras e respostas novas
        if (post.trigger_id) {
          const [t] = await tx`select config from autoflow.triggers where id = ${post.trigger_id} and workspace_id = ${ws}`;
          if (t) {
            const cfg = parseTriggerConfig('comment', { ...(t.config as object), ...automation });
            await tx`update autoflow.triggers set config = ${tx.json(cfg as any)}, flow_id = ${flowId} where id = ${post.trigger_id}`;
            triggerId = post.trigger_id;
          }
        }
      }
      return { flow_id: flowId, trigger_id: triggerId, name: finalName, notes, updated: Boolean(b.flow_id) };
    });
  });
}
