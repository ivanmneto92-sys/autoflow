// CÓPIA de ../../../src/flow/schema.ts — atualize com: npm run sync:schema (na raiz)
/**
 * Formato do fluxo (grafo de nós). O mesmo schema vale para o editor (painel) e para o motor.
 */
import { z } from 'zod';

const nodeId = z.string().min(1).max(64);
const next = nodeId.nullable().optional();

/** Link http(s) com domínio de verdade (pega erros como "https://https://site.com"). */
const httpUrl = z
  .string()
  .trim()
  .url('Link inválido')
  .refine((u) => /^https?:\/\/[^\s/:]+\.[^\s/]+/i.test(u), 'Link inválido: confira se não ficou "https://" repetido e se tem o domínio (ex.: https://site.com)');

/** Textos padrão dos botões 🔒 Só para seguidores. */
export const LOCK_DEFAULTS = {
  locked_text: 'Esse conteúdo é exclusivo para quem me segue 💜\n\n1️⃣ Toque em "Abrir perfil" e siga\n2️⃣ Volte aqui e toque em "Já sigo"',
  unlocked_text: 'Prontinho, obrigado por me seguir! 🎉 Aqui está 👇', // para quem acabou de seguir (tocou em "Já sigo")
  ready_text: 'Aqui está 👇', // para quem já seguia e tocou no botão pela 1ª vez
  // A Meta só libera o "segue?" depois que a pessoa ENVIA uma mensagem (toque em botão pode não bastar):
  consent_text: 'Quase lá! Toque em 👍 aqui embaixo para eu liberar 👇',
  consent_reply: '👍 Liberar',
  retry: 'Já sigo',
  profile: 'Abrir perfil',
};

/** Ações que rodam no toque de um botão / resposta rápida (sem precisar de um nó de Ação). */
export const ButtonActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag: z.string().trim().min(1, 'Escreva o nome da tag').max(60) }),
  z.object({ type: z.literal('remove_tag'), tag: z.string().trim().min(1, 'Escreva o nome da tag').max(60) }),
  z.object({ type: z.literal('set_field'), field: z.string().regex(/^[a-z0-9_]+$/, 'Nome do campo: letras minúsculas, números e _'), value: z.string().max(500) }),
  z.object({ type: z.literal('human_handoff') }),
]);
export type ButtonAction = z.infer<typeof ButtonActionSchema>;

export const ButtonSchema = z
  .object({
    label: z.string().min(1).max(20),
    next, // botão que continua o fluxo
    url: httpUrl.optional(), // OU botão de link
    // 🔒 Só para seguidores: ao tocar, confere se a pessoa segue antes de abrir o link / seguir o fluxo
    followers_only: z.boolean().optional(),
    actions: z.array(ButtonActionSchema).max(5).optional(), // rodam no toque (no link: quando o clique é rastreado)
  })
  .refine((b) => !(b.next && b.url), 'Botão não pode ter next e url ao mesmo tempo');

export const QuickReplySchema = z.object({ label: z.string().min(1).max(20), next, actions: z.array(ButtonActionSchema).max(5).optional() });

export const ConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('has_tag'), tag: z.string() }),
  z.object({ type: z.literal('field_exists'), field: z.string() }),
  z.object({ type: z.literal('field_equals'), field: z.string(), value: z.string() }),
  z.object({ type: z.literal('var_equals'), var: z.string(), value: z.string() }),
  z.object({ type: z.literal('business_hours') }),
  z.object({ type: z.literal('is_new_contact') }),
  z.object({ type: z.literal('is_follower') }), // a pessoa segue a conta (precisa ter interagido antes)
  z.object({ type: z.literal('clicked_link') }), // clicou em algum link deste fluxo (links rastreados)
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
  z.object({ type: z.literal('clear_field'), field: z.string() }), // apaga um campo do contato
  z.object({ type: z.literal('close_conversation') }), // marca a conversa como fechada no Inbox (reabre na próxima mensagem)
  // Registra um pedido (aparece na página Pedidos do painel). O número fica em {{var.order_number}}
  z.object({
    type: z.literal('create_order'),
    summary: z.string().max(1000).default(''), // aceita {{variáveis}}
    fields: z.array(z.string()).default([]), // campos do contato anexados ao pedido (ex.: nome, endereco)
    total: z.string().max(100).optional(), // valor: número ou {{field.total}}
  }),
  // Entrega um cupom único da campanha (página Cupons). Código em {{var.coupon_code}}; situação em {{var.coupon_status}}
  z.object({ type: z.literal('give_coupon'), campaign_id: z.string().uuid({ message: 'Escolha a campanha de cupons' }) }),
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
      // Botões 🔒: o que quem não segue recebe, e o texto que acompanha o link liberado
      locked_text: z.string().max(1000).optional(),
      unlocked_text: z.string().max(1000).optional(),
      ready_text: z.string().max(1000).optional(), // quem já seguia, no 1º toque
      retry_label: z.string().trim().min(1).max(20).optional(), // botão "Já sigo"
      profile_label: z.string().trim().min(1).max(20).optional(), // botão "Abrir perfil"
      // Foto enviada antes do texto (conta como 1 mensagem a mais)
      image_url: httpUrl.optional(),
      // Salva a opção tocada (texto do botão / resposta rápida) neste campo do contato — dispensa um nó de Ação por opção
      save_to: z.string().regex(/^[a-z0-9_]+$/, 'Nome do campo: letras minúsculas, números e _').optional(),
    }),
    next,
  }),
  z.object({ type: z.literal('image'), data: z.object({ url: httpUrl }), next }),
  // Arquivo PDF (até 25 MB, limite da Meta)
  z.object({ type: z.literal('file'), data: z.object({ url: httpUrl, name: z.string().max(120).optional() }), next }),
  z.object({
    type: z.literal('carousel'),
    data: z.object({
      cards: z
        .array(
          z.object({
            title: z.string().min(1).max(80),
            subtitle: z.string().max(80).optional(),
            image_url: httpUrl.optional(),
            url: httpUrl.optional(),
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
      options: z.array(z.string().trim().min(1).max(20)).max(11).optional(), // sugestões tocáveis (aceita digitar também)
      skip_label: z.string().trim().min(1).max(20).optional(), // botão "Pular": segue sem salvar
      reminder_minutes: z.number().int().min(5).max(60 * 23).optional(), // lembra uma vez se não responder
      reminder_text: z.string().max(1000).optional(),
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
  // Cobrança por Pix: manda o código e espera o pagamento. Pago → next; venceu → on_expired
  z.object({
    type: z.literal('charge'),
    data: z.object({
      amount: z.string().trim().min(1).max(100), // "49,90" ou "{{field.total}}"
      description: z.string().max(140).default('Pedido'),
      provider: z.enum(['mercadopago', 'asaas']).optional(), // vazio = o padrão do negócio
      expires_minutes: z.number().int().min(5).max(1440).default(30),
      text: z.string().max(800).default('Para pagar, copie o código Pix abaixo e cole no app do seu banco 👇'),
      cpf: z.string().max(100).optional(), // Asaas exige CPF: ex. {{field.cpf}}
      on_expired: next,
    }),
    next,
  }),
  // Só seguidores: a Meta só deixa conferir se a pessoa segue depois que ela interage (clica ou escreve).
  // Então o bloco pede um clique, confere e só segue em frente para quem segue; quem não segue recebe
  // o pedido para seguir com o botão "Já sigo" (nunca fica sem resposta).
  z.object({
    type: z.literal('follow_gate'),
    data: z.object({
      text: z.string().min(1).max(1000).default('Esse conteúdo é exclusivo para quem me segue. Toque no botão abaixo que eu confiro rapidinho 👇'),
      button: z.string().trim().min(1).max(20).default('Quero receber'),
      not_following_text: z
        .string()
        .min(1)
        .max(1000)
        .default('Ainda não encontrei você entre os meus seguidores 😕\n\n1️⃣ Abra o meu perfil e toque em Seguir\n2️⃣ Volte aqui e toque em "Já sigo"'),
      retry_button: z.string().trim().min(1).max(20).default('Já sigo'),
    }),
    next,
  }),
  z.object({ type: z.literal('end') }),
]);

export const FlowGraphSchema = z.object({
  start: nodeId,
  nodes: z.record(nodeId, NodeSchema),
  // Posições no editor (ignorado pelo motor)
  layout: z.record(nodeId, z.object({ x: z.number(), y: z.number() })).optional(),
  // Respostas da Automação rápida que geraram este fluxo (para editar ou copiar depois; ignorado pelo motor)
  quick: z.record(z.unknown()).optional(),
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
    case 'charge':
      return [node.next, node.data.on_expired];
    case 'condition':
      return [...node.data.rules.map((r) => r.next), node.data.else];
    case 'randomizer':
      return node.data.branches.map((b) => b.next);
    case 'image':
    case 'file':
    case 'action':
    case 'delay':
    case 'follow_gate':
      return [node.next];
    default:
      return [];
  }
}

/** Ligações que o motor segue sem esperar a pessoa (sem clique, resposta ou pagamento). */
function immediateTargets(node: FlowNode): (string | null | undefined)[] {
  switch (node.type) {
    case 'message':
    case 'carousel':
    case 'image':
    case 'file':
    case 'action':
    case 'delay':
      return [node.next];
    case 'condition':
      return [...node.data.rules.map((r) => r.next), node.data.else];
    case 'randomizer':
      return node.data.branches.map((b) => b.next);
    default:
      return []; // ask, charge e follow_gate esperam a pessoa
  }
}

/** Nós executados logo no início, antes de a pessoa clicar ou responder qualquer coisa. */
export function immediateFromStart(graph: FlowGraph): string[] {
  const seen: string[] = [];
  const stack = [graph.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.includes(id) || !graph.nodes[id]) continue;
    seen.push(id);
    for (const t of immediateTargets(graph.nodes[id]!)) if (t) stack.push(t);
  }
  return seen;
}

/** Nós que mandam mensagem (contam para o limite de 1 mensagem depois de um comentário). */
export const SENDS_MESSAGE = new Set<FlowNode['type']>(['message', 'image', 'file', 'carousel', 'ask', 'charge', 'follow_gate']);

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
        if (!b.next && !b.url)
          issues.push({ level: 'warning', node: id, message: `Botão "${b.label}" não está ligado a nada: quem clicar não recebe resposta` });
      for (const q of node.data.quick_replies ?? [])
        if (!q.next) issues.push({ level: 'warning', node: id, message: `Resposta rápida "${q.label}" não está ligada a nada: quem tocar não recebe resposta` });
    }
    if (node.type === 'carousel')
      for (const c of node.data.cards)
        for (const b of c.buttons ?? [])
          if (!b.next && !b.url)
            issues.push({ level: 'warning', node: id, message: `Botão "${b.label}" (${c.title}) não está ligado a nada: quem clicar não recebe resposta` });
    if (node.type === 'condition') {
      node.data.rules.forEach((r, i) => {
        if (!r.next)
          issues.push({
            level: 'warning',
            node: id,
            message: `O caminho "${node.data.rules.length > 1 ? `regra ${i + 1}` : 'Se…'}" não está ligado a nada: quem cair nele fica sem resposta`,
          });
      });
      if (!node.data.else) issues.push({ level: 'warning', node: id, message: 'O caminho "Senão" não está ligado a nada: quem cair nele fica sem resposta' });
    }
    if (node.type === 'follow_gate' && !node.next)
      issues.push({ level: 'warning', node: id, message: 'Ligue a saída "Segue" ao conteúdo que o seguidor vai receber' });
  }

  // Conferir "segue a conta" antes de qualquer clique: a Meta não deixa (a pessoa só comentou) e o fluxo vai pelo "Senão"
  for (const id of immediateFromStart(graph)) {
    const n = graph.nodes[id]!;
    if (n.type === 'condition' && n.data.rules.some((r) => r.when.type === 'is_follower'))
      issues.push({
        level: 'warning',
        node: id,
        message:
          'A Meta só deixa conferir se a pessoa segue depois que ela toca num botão ou escreve. Aqui a checagem acontece antes disso e cai sempre no "Senão" — marque o botão da mensagem como 🔒 Só para seguidores.',
      });
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
  | { type: 'gate'; versionId: string; nodeId: string }
  | { type: 'lock'; versionId: string; nodeId: string; index: number; retry: boolean; consent: boolean }
  | { type: 'answer'; versionId: string; nodeId: string; index: number }
  | { type: 'skip'; versionId: string; nodeId: string }
  | { type: 'custom'; payload: string };

export const payload = {
  button: (v: string, n: string, i: number) => `af:b:${v}:${n}:${i}`,
  cardButton: (v: string, n: string, c: number, i: number) => `af:c:${v}:${n}:${c}:${i}`,
  quickReply: (v: string, n: string, i: number) => `af:q:${v}:${n}:${i}`,
  gate: (v: string, n: string) => `af:g:${v}:${n}`,
  // flags: r = veio do "Já sigo"; c = veio do 👍 (a pessoa já enviou mensagem)
  lock: (v: string, n: string, i: number, retry = false, consent = false) =>
    `af:l:${v}:${n}:${i}${retry || consent ? `:${retry ? 'r' : ''}${consent ? 'c' : ''}` : ''}`,
  answer: (v: string, n: string, i: number) => `af:a:${v}:${n}:${i}`, // sugestão da Pergunta (vale como resposta digitada)
  skip: (v: string, n: string) => `af:s:${v}:${n}`,
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
    if (parts[1] === 'a' && parts.length === 5) return { type: 'answer', versionId: parts[2]!, nodeId: parts[3]!, index: Number(parts[4]) };
    if (parts[1] === 's' && parts.length === 4) return { type: 'skip', versionId: parts[2]!, nodeId: parts[3]! };
    if (parts[1] === 'l' && (parts.length === 5 || parts.length === 6))
      return { type: 'lock', versionId: parts[2]!, nodeId: parts[3]!, index: Number(parts[4]), retry: Boolean(parts[5]?.includes('r')), consent: Boolean(parts[5]?.includes('c')) };
    if (parts[1] === 'g' && parts.length === 4) return { type: 'gate', versionId: parts[2]!, nodeId: parts[3]! };
  }
  return { type: 'custom', payload: p };
}
