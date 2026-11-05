/**
 * Formato do fluxo (grafo de nós). O mesmo schema vale para o editor (painel) e para o motor.
 */
import { z } from 'zod';

const nodeId = z.string().min(1).max(64);
const next = nodeId.nullable().optional();

export const ButtonSchema = z
  .object({
    label: z.string().min(1).max(20),
    next, // botão que continua o fluxo
    url: z.string().url().optional(), // OU botão de link
  })
  .refine((b) => !(b.next && b.url), 'Botão não pode ter next e url ao mesmo tempo');

export const QuickReplySchema = z.object({ label: z.string().min(1).max(20), next });

export const ConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('has_tag'), tag: z.string() }),
  z.object({ type: z.literal('field_exists'), field: z.string() }),
  z.object({ type: z.literal('field_equals'), field: z.string(), value: z.string() }),
  z.object({ type: z.literal('var_equals'), var: z.string(), value: z.string() }),
  z.object({ type: z.literal('business_hours') }),
  z.object({ type: z.literal('is_new_contact') }),
  z.object({
    type: z.literal('last_text_matches'),
    keywords: z.array(z.string()).min(1),
    match: z.enum(['exact', 'contains', 'starts_with']).default('contains'),
  }),
]);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag: z.string() }),
  z.object({ type: z.literal('remove_tag'), tag: z.string() }),
  z.object({ type: z.literal('set_field'), field: z.string(), value: z.string() }),
  z.object({ type: z.literal('set_var'), var: z.string(), value: z.string() }),
  z.object({ type: z.literal('human_handoff'), notify_text: z.string().optional() }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url(),
    method: z.enum(['POST', 'GET']).default('POST'),
    save_response_to: z.string().optional(), // var onde salvar o JSON de resposta
  }),
]);

export const NodeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    data: z.object({
      text: z.string().min(1).max(1000),
      buttons: z.array(ButtonSchema).max(3).optional(),
      quick_replies: z.array(QuickReplySchema).max(13).optional(),
    }),
    next,
  }),
  z.object({ type: z.literal('image'), data: z.object({ url: z.string().url() }), next }),
  z.object({
    type: z.literal('carousel'),
    data: z.object({
      cards: z
        .array(
          z.object({
            title: z.string().min(1).max(80),
            subtitle: z.string().max(80).optional(),
            image_url: z.string().url().optional(),
            url: z.string().url().optional(),
            buttons: z.array(ButtonSchema).max(3).optional(),
          }),
        )
        .min(1)
        .max(10),
    }),
    next,
  }),
  z.object({
    type: z.literal('ask'),
    data: z.object({
      text: z.string().min(1).max(1000),
      save_to: z.string().min(1), // campo personalizado (field) do contato
      validate: z.enum(['text', 'email', 'phone', 'number']).default('text'),
      retry_text: z.string().optional(),
      max_retries: z.number().int().min(0).max(5).default(2),
      timeout_minutes: z.number().int().min(1).max(60 * 23).optional(),
      on_timeout: next,
      on_invalid: next, // quando estoura as tentativas
    }),
    next,
  }),
  z.object({
    type: z.literal('condition'),
    data: z.object({
      rules: z.array(z.object({ when: ConditionSchema, next })).min(1),
      else: next,
    }),
  }),
  z.object({ type: z.literal('action'), data: z.object({ actions: z.array(ActionSchema).min(1) }), next }),
  z.object({ type: z.literal('delay'), data: z.object({ minutes: z.number().min(0.1).max(60 * 23) }), next }),
  z.object({
    type: z.literal('randomizer'),
    data: z.object({ branches: z.array(z.object({ weight: z.number().positive(), next })).min(2) }),
  }),
  z.object({ type: z.literal('goto_flow'), data: z.object({ flow_id: z.string().uuid() }) }),
  z.object({ type: z.literal('end') }),
]);

export const FlowGraphSchema = z.object({
  start: nodeId,
  nodes: z.record(nodeId, NodeSchema),
  // Posições no editor (ignorado pelo motor)
  layout: z.record(nodeId, z.object({ x: z.number(), y: z.number() })).optional(),
});

export type FlowGraph = z.infer<typeof FlowGraphSchema>;
export type FlowNode = z.infer<typeof NodeSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type FlowAction = z.infer<typeof ActionSchema>;

/** Lista todos os destinos (next) que um nó referencia. */
export function nodeTargets(node: FlowNode): (string | null | undefined)[] {
  switch (node.type) {
    case 'message':
      return [
        node.next,
        ...(node.data.buttons ?? []).map((b) => b.next),
        ...(node.data.quick_replies ?? []).map((q) => q.next),
      ];
    case 'carousel':
      return [node.next, ...node.data.cards.flatMap((c) => (c.buttons ?? []).map((b) => b.next))];
    case 'ask':
      return [node.next, node.data.on_timeout, node.data.on_invalid];
    case 'condition':
      return [...node.data.rules.map((r) => r.next), node.data.else];
    case 'randomizer':
      return node.data.branches.map((b) => b.next);
    case 'image':
    case 'action':
    case 'delay':
      return [node.next];
    default:
      return [];
  }
}

export interface GraphIssue {
  level: 'error' | 'warning';
  node?: string;
  message: string;
}

/** Valida o grafo antes de publicar. */
export function validateGraph(input: unknown): { graph?: FlowGraph; issues: GraphIssue[] } {
  const parsed = FlowGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((i) => ({ level: 'error', message: `${i.path.join('.')}: ${i.message}` })),
    };
  }
  const graph = parsed.data;
  const issues: GraphIssue[] = [];
  if (!graph.nodes[graph.start]) issues.push({ level: 'error', message: `Nó inicial "${graph.start}" não existe` });

  for (const [id, node] of Object.entries(graph.nodes)) {
    for (const t of nodeTargets(node)) {
      if (t && !graph.nodes[t]) issues.push({ level: 'error', node: id, message: `Aponta para nó inexistente "${t}"` });
    }
    if (node.type === 'goto_flow' && /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(node.data.flow_id))
      issues.push({ level: 'error', node: id, message: 'Escolha o fluxo de destino' });
    if (node.type === 'ask' && !/^[a-z0-9_]+$/.test(node.data.save_to))
      issues.push({ level: 'error', node: id, message: 'Nome do campo inválido (use letras minúsculas, números e _)' });
    if (node.type === 'message') {
      if (node.data.buttons?.length && node.data.quick_replies?.length)
        issues.push({ level: 'error', node: id, message: 'Use botões OU respostas rápidas, não os dois' });
      for (const b of node.data.buttons ?? [])
        if (!b.next && !b.url) issues.push({ level: 'warning', node: id, message: `Botão "${b.label}" sem destino` });
    }
  }

  // Nós inalcançáveis
  const seen = new Set<string>();
  const stack = [graph.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !graph.nodes[id]) continue;
    seen.add(id);
    for (const t of nodeTargets(graph.nodes[id]!)) if (t) stack.push(t);
  }
  for (const id of Object.keys(graph.nodes))
    if (!seen.has(id)) issues.push({ level: 'warning', node: id, message: 'Nó inalcançável' });

  return { graph, issues };
}

// ── Payloads de botões / respostas rápidas ──
// af:b:<versionId>:<nodeId>:<idx>   botão de message
// af:c:<versionId>:<nodeId>:<card>:<idx> botão de carousel
// af:q:<versionId>:<nodeId>:<idx>   resposta rápida
// af:t:<triggerId>                  inicia um gatilho (ice breaker / menu)
export type ParsedPayload =
  | { type: 'button'; versionId: string; nodeId: string; index: number }
  | { type: 'card_button'; versionId: string; nodeId: string; card: number; index: number }
  | { type: 'quick_reply'; versionId: string; nodeId: string; index: number }
  | { type: 'trigger'; triggerId: string }
  | { type: 'custom'; payload: string };

export const payload = {
  button: (v: string, n: string, i: number) => `af:b:${v}:${n}:${i}`,
  cardButton: (v: string, n: string, c: number, i: number) => `af:c:${v}:${n}:${c}:${i}`,
  quickReply: (v: string, n: string, i: number) => `af:q:${v}:${n}:${i}`,
  trigger: (t: string) => `af:t:${t}`,
};

export function parsePayload(p: string): ParsedPayload {
  const parts = p.split(':');
  if (parts[0] === 'af') {
    if (parts[1] === 'b' && parts.length === 5)
      return { type: 'button', versionId: parts[2]!, nodeId: parts[3]!, index: Number(parts[4]) };
    if (parts[1] === 'q' && parts.length === 5)
      return { type: 'quick_reply', versionId: parts[2]!, nodeId: parts[3]!, index: Number(parts[4]) };
    if (parts[1] === 'c' && parts.length === 6)
      return { type: 'card_button', versionId: parts[2]!, nodeId: parts[3]!, card: Number(parts[4]), index: Number(parts[5]) };
    if (parts[1] === 't' && parts.length === 3) return { type: 'trigger', triggerId: parts[2]! };
  }
  return { type: 'custom', payload: p };
}
