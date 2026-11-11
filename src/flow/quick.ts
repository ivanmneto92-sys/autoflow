/**
 * Automação rápida "Comentário → Direct" (como o assistente do ManyChat, mas gerando um fluxo normal e editável):
 * abertura com botão → (pede e-mail) → mensagem com os links → (espera e lembra quem não clicou).
 */
import { z } from 'zod';
import { LOCK_DEFAULTS, type FlowGraph, type FlowNode } from './schema.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const QuickCommentSchema = z.object({
  name: z.string().trim().max(100).optional(),
  opening: z
    .object({
      enabled: z.boolean().default(true),
      text: text(1000).default('Oi, {{first_name|tudo bem}}! 👋 Que bom que você comentou. Toque no botão abaixo que eu te mando agora 👇'),
      button: text(20).default('Quero receber'),
    })
    .default({}),
  followers_only: z.boolean().default(false),
  locked_text: z.string().max(1000).optional(),
  unlocked_text: z.string().max(1000).optional(),
  ready_text: z.string().max(1000).optional(),
  retry_label: z.string().trim().min(1).max(20).optional(),
  profile_label: z.string().trim().min(1).max(20).optional(),
  ask_email: z
    .object({ enabled: z.boolean().default(false), text: text(1000).default('Antes, me passa seu melhor e-mail? Assim te aviso das novidades 💌') })
    .default({}),
  message: z.object({
    text: text(1000),
    image_url: z.string().url().optional(),
    links: z.array(z.object({ label: text(20), url: z.string().trim().min(4).max(2000) })).max(3).default([]),
  }),
  follow_up: z
    .object({
      enabled: z.boolean().default(false),
      minutes: z.number().int().min(5).max(60 * 23).default(60),
      text: text(1000).default('Conseguiu ver o material? 👀 Deixo o link aqui de novo pra você:'),
    })
    .default({}),
});
export type QuickComment = z.infer<typeof QuickCommentSchema>;

const fixUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

/** Monta o fluxo. Depois de um comentário a Meta só deixa mandar 1 mensagem até a pessoa tocar num botão, por isso
 *  🔒, e-mail e lembrete exigem a mensagem de abertura (o toque libera o resto). */
export function buildCommentFlow(q: QuickComment): { graph: FlowGraph; notes: string[] } {
  const notes: string[] = [];
  const links = q.message.links.map((l) => ({ label: l.label, url: fixUrl(l.url) }));
  let followUp = q.follow_up.enabled;
  if (followUp && !links.length) {
    followUp = false;
    notes.push('Lembrete desligado: ele só faz sentido quando a mensagem tem link.');
  }
  let opening = q.opening.enabled;
  if (!opening && (q.followers_only || q.ask_email.enabled || followUp)) {
    opening = true;
    notes.push('A mensagem de abertura foi ligada: depois de um comentário, só ela libera as mensagens seguintes.');
  }

  const nodes: Record<string, FlowNode> = {};
  const order: string[] = [];
  const add = (id: string, n: FlowNode) => ((nodes[id] = n), order.push(id));
  const afterOpening = q.ask_email.enabled ? 'email' : 'entrega';

  if (opening)
    add('abertura', {
      type: 'message',
      data: {
        text: q.opening.text,
        buttons: [{ label: q.opening.button, next: afterOpening, ...(q.followers_only ? { followers_only: true } : {}) }],
        ...(q.followers_only
          ? {
              locked_text: q.locked_text?.trim() || LOCK_DEFAULTS.locked_text,
              ...(q.unlocked_text?.trim() ? { unlocked_text: q.unlocked_text.trim() } : {}),
              ...(q.ready_text?.trim() ? { ready_text: q.ready_text.trim() } : {}),
              ...(q.retry_label ? { retry_label: q.retry_label } : {}),
              ...(q.profile_label ? { profile_label: q.profile_label } : {}),
            }
          : {}),
      },
    } as FlowNode);
  if (q.ask_email.enabled)
    add('email', {
      type: 'ask',
      // Não responde em 30 min, erra o e-mail ou toca em "Agora não": recebe o material do mesmo jeito
      data: { text: q.ask_email.text, save_to: 'email', validate: 'email', max_retries: 1, on_invalid: 'entrega', skip_label: 'Agora não', timeout_minutes: 30, on_timeout: 'entrega' },
      next: 'entrega',
    } as FlowNode);
  add('entrega', {
    type: 'message',
    data: {
      text: q.message.text,
      ...(q.message.image_url ? { image_url: q.message.image_url } : {}),
      ...(links.length ? { buttons: links } : {}),
    },
    next: followUp ? 'espera' : null,
  } as FlowNode);
  if (followUp) {
    add('espera', { type: 'delay', data: { minutes: q.follow_up.minutes }, next: 'clicou' });
    add('clicou', { type: 'condition', data: { rules: [{ when: { type: 'clicked_link' }, next: 'fim' }], else: 'lembrete' } });
    add('lembrete', { type: 'message', data: { text: q.follow_up.text, buttons: links } } as FlowNode);
    add('fim', { type: 'end' });
  }

  // Posições organizadas da esquerda para a direita (o "Quando…" fica à esquerda)
  const layout: Record<string, { x: number; y: number }> = { __start: { x: 0, y: 80 } };
  order.forEach((id, i) => (layout[id] = { x: 360 + i * 330, y: 80 }));
  return { graph: { start: order[0]!, nodes, layout }, notes };
}

/**
 * Reconstrói as respostas do assistente a partir de um fluxo criado por ele antes de as respostas serem guardadas
 * (nós abertura / email / entrega / espera / clicou / lembrete / fim). Devolve null se o fluxo não tem esse formato.
 * `auto`: palavras e respostas públicas, que ficam no post ou no gatilho (não no fluxo).
 */
export function quickFromGraph(
  g: FlowGraph,
  auto?: { keywords?: string[]; match?: string; public_replies?: string[]; once_per_contact?: boolean } | null,
): Record<string, unknown> | null {
  const allowed = new Set(['abertura', 'email', 'entrega', 'espera', 'clicou', 'lembrete', 'fim']);
  if (!g?.nodes || Object.keys(g.nodes).some((k) => !allowed.has(k))) return null;
  const entrega = g.nodes.entrega;
  if (entrega?.type !== 'message') return null;
  const ab = g.nodes.abertura;
  const em = g.nodes.email;
  const espera = g.nodes.espera;
  const lembrete = g.nodes.lembrete;
  const btn = ab?.type === 'message' ? ab.data.buttons?.[0] : undefined;
  return {
    keywords: auto?.keywords ?? [],
    match: auto?.match ?? 'contains',
    public_replies: auto?.public_replies ?? [],
    once_per_contact: auto?.once_per_contact ?? true,
    opening: ab?.type === 'message' ? { enabled: true, text: ab.data.text, button: btn?.label ?? 'Quero receber' } : { enabled: false },
    followers_only: Boolean(btn?.followers_only),
    ...(ab?.type === 'message' && btn?.followers_only
      ? {
          locked_text: ab.data.locked_text,
          unlocked_text: ab.data.unlocked_text,
          ready_text: ab.data.ready_text,
          retry_label: ab.data.retry_label,
          profile_label: ab.data.profile_label,
        }
      : {}),
    ask_email: em?.type === 'ask' ? { enabled: true, text: em.data.text } : { enabled: false },
    message: {
      text: entrega.data.text,
      ...(entrega.data.image_url ? { image_url: entrega.data.image_url } : {}),
      links: (entrega.data.buttons ?? []).filter((b) => b.url).map((b) => ({ label: b.label, url: b.url! })),
    },
    follow_up:
      espera?.type === 'delay' && lembrete?.type === 'message'
        ? { enabled: true, minutes: espera.data.minutes, text: lembrete.data.text }
        : { enabled: false },
  };
}
