/**
 * Automação rápida "Comentário → Direct": cria o fluxo pronto (publicado) e liga no post escolhido.
 * O resultado é um fluxo normal — dá para abrir no editor e ajustar depois.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCommentFlow, QuickCommentSchema } from '../../flow/quick.js';
import { validateGraph } from '../../flow/schema.js';
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
});

export async function automationRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();

  app.post('/app/automations/comment-dm', async (req) => {
    const ws = wsOf(req);
    const b = Body.parse(req.body);
    const { graph, notes } = buildCommentFlow(b);
    const { graph: valid, issues } = validateGraph(graph);
    const errors = issues.filter((i) => i.level === 'error');
    if (!valid || errors.length) throw new HttpError(400, errors.map((e) => e.message.replace(/^nodes\.[^.]+\.data\./, '')).join('; '));

    const keywords = b.keywords.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean);
    const automation = { keywords, match: b.match, public_replies: b.public_replies, once_per_contact: b.once_per_contact };
    const name = b.name?.trim() || `Comentário → Direct${keywords.length ? ` (${keywords.slice(0, 2).join(', ')})` : ''}`;

    return sql.begin(async (tx) => {
      if (b.target.kind === 'scheduled') {
        const [p] = await tx`
          select id from autoflow.scheduled_posts where id = ${b.target.post_id} and workspace_id = ${ws}
            and status in ('scheduled', 'failed', 'cancelled') for update`;
        if (!p) throw new HttpError(409, 'Essa publicação já saiu ou não existe. Escolha "Um post já publicado".');
      }
      const [f] = await tx`
        insert into autoflow.flows (workspace_id, name, draft_graph) values (${ws}, ${name.slice(0, 100)}, ${tx.json(valid as any)})
        returning id`;
      const [v] = await tx`
        insert into autoflow.flow_versions (flow_id, version, graph) values (${f!.id}, 1, ${tx.json(valid as any)}) returning id`;
      await tx`update autoflow.flows set status = 'published', published_version_id = ${v!.id} where id = ${f!.id}`;

      let triggerId: string | null = null;
      if (b.target.kind === 'any' || b.target.kind === 'media') {
        const cfg = parseTriggerConfig('comment', { media_id: b.target.kind === 'media' ? b.target.media_id : null, ...automation });
        const [t] = await tx`
          insert into autoflow.triggers (workspace_id, flow_id, type, config, priority)
          values (${ws}, ${f!.id}, 'comment', ${tx.json(cfg as any)}, ${b.target.kind === 'media' ? 10 : 0}) returning id`;
        triggerId = t!.id as string;
      } else if (b.target.kind === 'scheduled') {
        await tx`
          update autoflow.scheduled_posts set automation = ${tx.json({ flow_id: f!.id, ...automation } as any)}, updated_at = now()
          where id = ${b.target.post_id}`;
      }
      return { flow_id: f!.id as string, trigger_id: triggerId, notes };
    });
  });
}
