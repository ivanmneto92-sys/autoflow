/**
 * Modelos de fluxo prontos (pasta templates/). Cada modelo pode ter "perguntas" (inputs) que preenchem
 * os marcadores [[chave]] em todo o fluxo e nos gatilhos — a pessoa só responde e publica.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TriggerConfigSchemas } from './triggers.js';
import { validateGraph, type FlowGraph } from './schema.js';

export const TEMPLATE_CATEGORIES = {
  geral: 'Para qualquer negócio',
  restaurante: 'Restaurante e delivery',
  loja: 'Loja',
  servicos: 'Serviços e agendamento',
  influenciador: 'Influenciadores e criadores',
  infoprodutor: 'Infoprodutores',
  advogado: 'Advogados',
  contador: 'Contadores',
  imobiliaria: 'Imobiliária e corretores',
} as const;
export type TemplateCategory = keyof typeof TEMPLATE_CATEGORIES;

const InputSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'url', 'phone', 'money', 'keyword']).default('text'),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  default: z.string().optional(),
  required: z.boolean().default(true),
});
export type TemplateInput = z.infer<typeof InputSchema>;

const TemplateSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  category: z.enum(Object.keys(TEMPLATE_CATEGORIES) as [TemplateCategory, ...TemplateCategory[]]).default('geral'),
  icon: z.string().default('⚡'),
  tags: z.array(z.string()).default([]),
  inputs: z.array(InputSchema).default([]),
  flow: z.unknown(),
  triggers: z
    .array(z.object({ type: z.enum(Object.keys(TriggerConfigSchemas) as [keyof typeof TriggerConfigSchemas]), priority: z.number().int().default(0), config: z.unknown() }))
    .default([]),
});
export type Template = z.infer<typeof TemplateSchema> & { id: string };

let cache: Template[] | undefined;

export function loadTemplates(dir = join(process.cwd(), 'templates')): Template[] {
  if (cache && dir === join(process.cwd(), 'templates')) return cache;
  const order = Object.keys(TEMPLATE_CATEGORIES);
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ''), ...TemplateSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))) }))
    // Galeria agrupada na ordem das categorias (o sort é estável: dentro da categoria fica a ordem dos arquivos)
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  if (dir === join(process.cwd(), 'templates')) cache = list;
  return list;
}

export class TemplateInputError extends Error {}

const PLACEHOLDER = /\[\[([a-z0-9_]+)\]\]/g;

/** Normaliza e confere uma resposta conforme o tipo da pergunta. */
function normalize(input: TemplateInput, raw: string | undefined): string {
  let v = (raw ?? '').trim();
  if (!v && input.default !== undefined) v = input.default;
  if (!v) {
    if (input.required) throw new TemplateInputError(`Preencha: ${input.label}`);
    return '';
  }
  switch (input.type) {
    case 'url':
      if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
      if (!/^https?:\/\/[^\s/:]+\.[^\s/]+/i.test(v)) throw new TemplateInputError(`${input.label}: link inválido (ex.: https://seusite.com.br)`);
      return v;
    case 'phone': {
      let d = v.replace(/\D/g, '');
      if (d.length === 10 || d.length === 11) d = `55${d}`;
      if (d.length < 12 || d.length > 13) throw new TemplateInputError(`${input.label}: use DDD + número (ex.: 31 99999-9999)`);
      return d;
    }
    case 'keyword':
      return v.replace(/\s+/g, ' ');
    default:
      return v;
  }
}

/** Troca os [[marcadores]] em todos os textos do valor (recursivo). */
function fill<T>(value: T, values: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_m, k: string) => values[k] ?? '') as T;
  if (Array.isArray(value)) return value.map((v) => fill(v, values)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, values)])) as T;
  return value;
}

/** Aplica as respostas: devolve o fluxo e os gatilhos prontos (e já validados). */
export function applyTemplate(t: Template, answers: Record<string, string | undefined> = {}) {
  const values: Record<string, string> = {};
  for (const input of t.inputs) values[input.key] = normalize(input, answers[input.key]);
  const flow = fill(t.flow, values) as FlowGraph;
  const triggers = fill(t.triggers, values).map((tr) => ({
    ...tr,
    // Palavras-chave que vieram de resposta vazia somem
    config: cleanKeywords(tr.config),
  }));
  const { graph, issues } = validateGraph(flow);
  const errors = issues.filter((i) => i.level === 'error');
  if (!graph || errors.length) throw new TemplateInputError(`O modelo ficou inválido: ${errors.map((e) => e.message).join('; ')}`);
  return { flow: graph, triggers };
}

function cleanKeywords(config: unknown) {
  const c = (config ?? {}) as { keywords?: string[] };
  if (Array.isArray(c.keywords)) return { ...c, keywords: c.keywords.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean) };
  return c;
}

/** Texto da prévia: {{first_name|…}} vira "Maria", outras variáveis somem e [[chave]] vira «Pergunta». */
function previewText(t: Template, text: string): string {
  return text
    .split('\n')
    .find((l) => l.trim())!
    .replace(/\{\{\s*first_name[^}]*\}\}/g, 'Maria')
    .replace(/\{\{[^}]*\}\}/g, '…')
    .replace(PLACEHOLDER, (_m, k: string) => `«${t.inputs.find((i) => i.key === k)?.label ?? k}»`)
    .slice(0, 110);
}

/** Resumo para a galeria: o que o fluxo faz, passo a passo (só os primeiros passos). */
export function templatePreview(t: Template): string[] {
  const g = t.flow as FlowGraph;
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [g.start];
  while (queue.length && out.length < 8) {
    const id = queue.shift()!;
    if (seen.has(id) || !g.nodes[id]) continue;
    seen.add(id);
    const n = g.nodes[id]!;
    switch (n.type) {
      case 'message': {
        out.push(`💬 ${previewText(t, n.data.text)}`);
        const labels = [...(n.data.buttons ?? []), ...(n.data.quick_replies ?? [])].map((b) => b.label);
        if (labels.length) out.push(`🔘 Botões: ${labels.join(' · ')}`);
        break;
      }
      case 'ask':
        out.push(`❓ ${previewText(t, n.data.text)}`);
        break;
      case 'condition':
        out.push(
          n.data.rules.some((r) => r.when.type === 'is_follower') ? '🔀 Confere se a pessoa segue o perfil' : '🔀 Confere uma condição e escolhe o caminho',
        );
        break;
      case 'charge':
        out.push('💸 Cobra por Pix e espera o pagamento');
        break;
      case 'action':
        for (const a of n.data.actions)
          if (a.type === 'create_order') out.push('🧾 Registra na página Pedidos');
          else if (a.type === 'human_handoff') out.push('👤 Passa para um atendente');
          else if (a.type === 'give_coupon') out.push('🎟 Entrega um cupom único');
        break;
      case 'delay':
        out.push(`⏱ Espera ${n.data.minutes >= 60 ? `${Math.round(n.data.minutes / 60)} h` : `${n.data.minutes} min`}`);
        break;
    }
    const next: (string | null | undefined)[] = [];
    if ('next' in n) next.push(n.next);
    if (n.type === 'message') next.push(...(n.data.buttons ?? []).map((b) => ('next' in b ? b.next : undefined)), ...(n.data.quick_replies ?? []).map((q) => q.next));
    if (n.type === 'condition') next.push(...n.data.rules.map((r) => r.next), n.data.else);
    for (const x of next) if (x) queue.push(x);
  }
  return out.slice(0, 9);
}
