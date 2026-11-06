/**
 * Conversão entre o grafo do autoflow (o mesmo JSON que o motor executa) e o canvas do React Flow.
 */
import type { Edge, Node } from '@xyflow/react';
import type { FlowGraph, FlowNode } from '../shared/schema';

export type NodeType = FlowNode['type'];
export const START_ID = '__start';

export const NODE_META: Record<NodeType, { label: string; color: string; icon: string; hint: string }> = {
  message: { label: 'Mensagem', color: '#5b5bd6', icon: '💬', hint: 'Texto com botões ou respostas rápidas' },
  image: { label: 'Imagem', color: '#0ea5e9', icon: '🖼', hint: 'Envia uma imagem por URL' },
  carousel: { label: 'Carrossel', color: '#06b6d4', icon: '🗂', hint: 'Cartões com foto e botões' },
  ask: { label: 'Pergunta', color: '#f59e0b', icon: '❓', hint: 'Espera a resposta e salva num campo' },
  condition: { label: 'Condição', color: '#8b5cf6', icon: '🔀', hint: 'Divide o caminho por regras' },
  action: { label: 'Ação', color: '#10b981', icon: '⚙', hint: 'Tags, campos, webhook, atendente' },
  delay: { label: 'Atraso', color: '#64748b', icon: '⏱', hint: 'Espera um tempo antes de seguir' },
  randomizer: { label: 'Teste A/B', color: '#ec4899', icon: '🎲', hint: 'Sorteia um caminho' },
  goto_flow: { label: 'Ir para fluxo', color: '#0f766e', icon: '↪', hint: 'Continua em outro fluxo' },
  charge: { label: 'Cobrar Pix', color: '#16a34a', icon: '💸', hint: 'Manda o Pix e espera o pagamento' },
  end: { label: 'Fim', color: '#94a3b8', icon: '■', hint: 'Encerra o fluxo' },
};

export const PALETTE: NodeType[] = ['message', 'ask', 'condition', 'action', 'charge', 'delay', 'image', 'carousel', 'randomizer', 'goto_flow', 'end'];

export function newNode(type: NodeType): FlowNode {
  switch (type) {
    case 'message':
      return { type, data: { text: 'Escreva a mensagem…' }, next: null };
    case 'image':
      return { type, data: { url: 'https://' }, next: null };
    case 'carousel':
      return { type, data: { cards: [{ title: 'Título do cartão', subtitle: '', buttons: [] }] }, next: null };
    case 'ask':
      return { type, data: { text: 'Qual é o seu nome?', save_to: 'nome', validate: 'text', max_retries: 2 }, next: null };
    case 'condition':
      return { type, data: { rules: [{ when: { type: 'business_hours' }, next: null }], else: null } };
    case 'action':
      return { type, data: { actions: [{ type: 'add_tag', tag: 'nova-tag' }] }, next: null };
    case 'delay':
      return { type, data: { minutes: 5 }, next: null };
    case 'randomizer':
      return { type, data: { branches: [{ weight: 50, next: null }, { weight: 50, next: null }] } };
    case 'goto_flow':
      return { type, data: { flow_id: '00000000-0000-0000-0000-000000000000' } };
    case 'charge':
      return {
        type,
        data: {
          amount: '{{field.total}}',
          description: 'Pedido #{{var.order_number}}',
          expires_minutes: 30,
          text: 'Para pagar, copie o código Pix abaixo e cole no app do seu banco 👇',
          on_expired: null,
        },
        next: null,
      };
    case 'end':
      return { type };
  }
}

export interface Output {
  id: string;
  label: string;
  target: string | null | undefined;
}

/** Saídas (pontos de conexão à direita) de cada nó. */
export function outputsOf(node: FlowNode): Output[] {
  switch (node.type) {
    case 'message': {
      const outs: Output[] = [];
      (node.data.buttons ?? []).forEach((b, i) => {
        if (!b.url) outs.push({ id: `btn-${i}`, label: `🔘 ${b.label}`, target: b.next });
      });
      (node.data.quick_replies ?? []).forEach((q, i) => outs.push({ id: `qr-${i}`, label: `⚡ ${q.label}`, target: q.next }));
      outs.push({ id: 'next', label: outs.length ? 'Depois (sem esperar clique)' : 'Próximo', target: node.next });
      return outs;
    }
    case 'carousel': {
      const outs: Output[] = [];
      node.data.cards.forEach((c, ci) =>
        (c.buttons ?? []).forEach((b, i) => {
          if (!b.url) outs.push({ id: `card-${ci}-${i}`, label: `🔘 ${c.title.slice(0, 14)} · ${b.label}`, target: b.next });
        }),
      );
      outs.push({ id: 'next', label: 'Próximo', target: node.next });
      return outs;
    }
    case 'ask': {
      const outs: Output[] = [{ id: 'next', label: '✅ Respondeu', target: node.next }];
      if (node.data.validate !== 'text') outs.push({ id: 'invalid', label: '⚠ Resposta inválida', target: node.data.on_invalid });
      if (node.data.timeout_minutes) outs.push({ id: 'timeout', label: '⏰ Não respondeu', target: node.data.on_timeout });
      return outs;
    }
    case 'condition':
      return [
        ...node.data.rules.map((r, i) => ({ id: `rule-${i}`, label: `Se ${describeCondition(r.when)}`, target: r.next })),
        { id: 'else', label: 'Senão', target: node.data.else },
      ];
    case 'randomizer': {
      const total = node.data.branches.reduce((s, b) => s + b.weight, 0) || 1;
      return node.data.branches.map((b, i) => ({
        id: `branch-${i}`,
        label: `${String.fromCharCode(65 + i)} · ${Math.round((b.weight / total) * 100)}%`,
        target: b.next,
      }));
    }
    case 'image':
    case 'action':
    case 'delay':
      return [{ id: 'next', label: 'Próximo', target: node.next }];
    case 'charge':
      return [
        { id: 'next', label: '✅ Pagou', target: node.next },
        { id: 'expired', label: '⏰ Não pagou (venceu)', target: node.data.on_expired },
      ];
    default:
      return [];
  }
}

/** Liga (ou desliga, com target null) uma saída a um nó. Retorna um novo nó. */
export function setOutput(node: FlowNode, handle: string, target: string | null): FlowNode {
  const n = structuredClone(node) as any;
  const [kind, a, b] = handle.split('-');
  if (handle === 'next') n.next = target;
  else if (kind === 'btn') n.data.buttons[Number(a)].next = target;
  else if (kind === 'qr') n.data.quick_replies[Number(a)].next = target;
  else if (kind === 'card') n.data.cards[Number(a)].buttons[Number(b)].next = target;
  else if (handle === 'invalid') n.data.on_invalid = target;
  else if (handle === 'timeout') n.data.on_timeout = target;
  else if (handle === 'expired') n.data.on_expired = target;
  else if (kind === 'rule') n.data.rules[Number(a)].next = target;
  else if (handle === 'else') n.data.else = target;
  else if (kind === 'branch') n.data.branches[Number(a)].next = target;
  return n;
}

export function describeCondition(c: any): string {
  switch (c?.type) {
    case 'business_hours':
      return 'está aberto';
    case 'is_new_contact':
      return 'é contato novo';
    case 'is_follower':
      return 'segue a conta';
    case 'has_tag':
      return `tem a tag "${c.tag}"`;
    case 'field_exists':
      return `tem ${c.field}`;
    case 'field_equals':
      return `${c.field} = "${c.value}"`;
    case 'var_equals':
      return `var ${c.var} = "${c.value}"`;
    case 'last_text_matches':
      return `texto contém "${(c.keywords ?? []).join('", "')}"`;
    default:
      return '?';
  }
}

export function summarize(node: FlowNode): string {
  switch (node.type) {
    case 'message':
    case 'ask':
      return node.data.text;
    case 'image':
      return node.data.url;
    case 'carousel':
      return node.data.cards.map((c) => `• ${c.title}`).join('\n');
    case 'condition':
      return '';
    case 'action':
      return node.data.actions.map(describeAction).join('\n');
    case 'delay':
      return node.data.minutes >= 60 ? `Espera ${+(node.data.minutes / 60).toFixed(1)} h` : `Espera ${node.data.minutes} min`;
    case 'randomizer':
      return '';
    case 'goto_flow':
      return 'Continua em outro fluxo';
    case 'charge':
      return `Pix de ${node.data.amount} · vence em ${node.data.expires_minutes} min`;
    case 'end':
      return 'Encerra a conversa automática';
  }
}

export function describeAction(a: any): string {
  switch (a.type) {
    case 'add_tag':
      return `+ tag ${a.tag}`;
    case 'remove_tag':
      return `− tag ${a.tag}`;
    case 'set_field':
      return `${a.field} = ${a.value}`;
    case 'set_var':
      return `var ${a.var} = ${a.value}`;
    case 'human_handoff':
      return '👤 Passar para atendente';
    case 'webhook':
      return `🌐 Webhook ${a.method} ${a.url}`;
    case 'create_order':
      return '🧾 Registrar pedido';
    default:
      return a.type;
  }
}

export function uniqueId(graph: FlowGraph, type: string): string {
  let i = Object.keys(graph.nodes).length + 1;
  let id = `${type}_${i}`;
  while (graph.nodes[id]) id = `${type}_${++i}`;
  return id;
}

/** Posições automáticas (colunas por distância do início) para fluxos sem layout salvo. */
export function autoLayout(graph: FlowGraph): Record<string, { x: number; y: number }> {
  const depth: Record<string, number> = {};
  const queue: [string, number][] = [[graph.start, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (depth[id] !== undefined || !graph.nodes[id]) continue;
    depth[id] = d;
    for (const o of outputsOf(graph.nodes[id]!)) if (o.target) queue.push([o.target, d + 1]);
  }
  let maxDepth = Math.max(0, ...Object.values(depth));
  for (const id of Object.keys(graph.nodes)) if (depth[id] === undefined) depth[id] = ++maxDepth;
  const rows: Record<number, number> = {};
  const pos: Record<string, { x: number; y: number }> = {};
  for (const id of Object.keys(graph.nodes).sort((a, b) => depth[a]! - depth[b]!)) {
    const d = depth[id]!;
    const r = rows[d] ?? 0;
    rows[d] = r + 1;
    pos[id] = { x: 360 + d * 340, y: 40 + r * 260 };
  }
  pos[START_ID] = { x: 20, y: 60 };
  return pos;
}

export function toCanvas(
  graph: FlowGraph,
  opts: { selected: string | null; errors: Set<string>; stats?: Record<string, number> },
): { nodes: Node[]; edges: Edge[] } {
  const layout = { ...autoLayout(graph), ...(graph.layout ?? {}) };
  // O nó "Quando…" é largo: se estiver em cima do primeiro nó (fluxos antigos), afasta para a esquerda
  let startPos = layout[START_ID] ?? { x: 20, y: 60 };
  const first = layout[graph.start];
  if (first && startPos.x > first.x - 300 && startPos.x < first.x + 260 && Math.abs(startPos.y - first.y) < 220)
    startPos = { x: first.x - 330, y: first.y };
  const nodes: Node[] = [{ id: START_ID, type: 'start', position: startPos, data: {}, deletable: false, selectable: false }];
  const edges: Edge[] = [];
  if (graph.nodes[graph.start]) {
    edges.push({ id: `${START_ID}:start`, source: START_ID, sourceHandle: 'start', target: graph.start, animated: true, deletable: false });
  }
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes.push({
      id,
      type: 'flow',
      position: layout[id] ?? { x: 300, y: 300 },
      data: { node, hasError: opts.errors.has(id), count: opts.stats?.[id], isStart: id === graph.start },
      selected: id === opts.selected,
    });
    for (const o of outputsOf(node)) {
      if (o.target && graph.nodes[o.target]) {
        edges.push({ id: `${id}:${o.id}`, source: id, sourceHandle: o.id, target: o.target, type: 'smoothstep' });
      }
    }
  }
  return { nodes, edges };
}

/** Remove um nó e as ligações que apontam para ele. */
export function removeNode(graph: FlowGraph, id: string): FlowGraph {
  const g = structuredClone(graph);
  delete g.nodes[id];
  if (g.layout) delete g.layout[id];
  for (const [nid, node] of Object.entries(g.nodes)) {
    let n = node;
    for (const o of outputsOf(node)) if (o.target === id) n = setOutput(n, o.id, null);
    g.nodes[nid] = n;
  }
  if (g.start === id) g.start = Object.keys(g.nodes)[0] ?? '';
  return g;
}
