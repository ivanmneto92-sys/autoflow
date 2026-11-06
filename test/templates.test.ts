import { describe, expect, it } from 'vitest';
import { applyTemplate, loadTemplates, TEMPLATE_CATEGORIES, TemplateInputError, templatePreview } from '../src/flow/templates.js';
import { parseTriggerConfig } from '../src/flow/triggers.js';

const SAMPLE: Record<string, string> = {
  text: 'Exemplo',
  textarea: 'Linha 1\nLinha 2',
  url: 'meusite.com.br/pagina',
  phone: '(31) 99999-9999',
  money: '49,90',
  keyword: 'quero, eu quero',
};

describe('galeria de modelos', () => {
  const all = loadTemplates();

  it('tem dezenas de modelos, em todas as categorias, com ids únicos', () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    for (const c of Object.keys(TEMPLATE_CATEGORIES)) expect(all.some((t) => t.category === c), c).toBe(true);
  });

  for (const t of all) {
    it(`${t.id}: respostas preenchem tudo e o fluxo fica válido`, () => {
      const answers = Object.fromEntries(t.inputs.map((i) => [i.key, SAMPLE[i.type]!]));
      const { flow, triggers } = applyTemplate(t, answers);
      expect(JSON.stringify({ flow, triggers })).not.toMatch(/\[\[[a-z0-9_]+\]\]/);
      for (const tr of triggers) expect(() => parseTriggerConfig(tr.type, tr.config)).not.toThrow();
      expect(templatePreview(t).length).toBeGreaterThan(0);
      // Todo marcador usado tem pergunta
      const used = [...JSON.stringify({ f: t.flow, tr: t.triggers }).matchAll(/\[\[([a-z0-9_]+)\]\]/g)].map((m) => m[1]);
      for (const k of used) expect(t.inputs.some((i) => i.key === k), `${t.id}: [[${k}]] sem pergunta`).toBe(true);
    });
  }

  it('normaliza link e telefone; cobra campo obrigatório', () => {
    const t = all.find((x) => x.inputs.some((i) => i.type === 'url' && i.required))!;
    const answers = Object.fromEntries(t.inputs.map((i) => [i.key, SAMPLE[i.type]!]));
    const out = JSON.stringify(applyTemplate(t, answers).flow);
    expect(out).toContain('https://meusite.com.br/pagina');
    const urlKey = t.inputs.find((i) => i.type === 'url' && i.required)!.key;
    expect(() => applyTemplate(t, { ...answers, [urlKey]: '' })).toThrow(TemplateInputError);
    expect(() => applyTemplate(t, { ...answers, [urlKey]: 'nao é link' })).toThrow(TemplateInputError);

    const p = all.find((x) => x.inputs.some((i) => i.type === 'phone'));
    if (p) {
      const a = Object.fromEntries(p.inputs.map((i) => [i.key, SAMPLE[i.type]!]));
      expect(JSON.stringify(applyTemplate(p, a))).toContain('5531999999999');
    }
  });

  it('palavras-chave separadas por vírgula viram uma lista', () => {
    const t = all.find((x) => x.inputs.some((i) => i.type === 'keyword'))!;
    const answers = Object.fromEntries(t.inputs.map((i) => [i.key, SAMPLE[i.type]!]));
    const kws = applyTemplate(t, answers).triggers.flatMap((tr) => ((tr.config as { keywords?: string[] }).keywords ?? []));
    expect(kws).toEqual(expect.arrayContaining(['quero', 'eu quero']));
  });
});
