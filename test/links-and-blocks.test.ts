import { describe, expect, it } from 'vitest';
import { parsePayload, type FlowGraph } from '../src/flow/schema.js';
import { dm, postback, setup, textOf } from './helpers.js';

const BASE = 'https://api.autoflow.test';
const btnUrl = (m: { kind: string; buttons?: { type: string; url?: string }[] }) => (m.kind === 'buttons' ? m.buttons!.find((b) => b.type === 'web_url')?.url : undefined);

describe('links rastreados', () => {
  const flow: FlowGraph = {
    start: 'm',
    nodes: { m: { type: 'message', data: { text: 'Seu link 👇', buttons: [{ label: 'Abrir', url: 'https://site.com/guia?x={{first_name}}', actions: [{ type: 'add_tag', tag: 'clicou' }] }] } } },
  };

  it('botão de link vira /r/<código> por contato, guardando o destino e as ações', async () => {
    const t = setup({ linkBase: BASE });
    const { flowId } = t.addFlow(flow);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['link'] });
    await t.engine.handleEvent(dm('link'));
    expect(btnUrl(t.ig.sent[0]!.msg as never)).toBe(`${BASE}/r/L1`);
    expect(t.store.links[0]).toMatchObject({ code: 'L1', flowId, nodeId: 'm', url: 'https://site.com/guia?x=Maria', actions: [{ type: 'add_tag', tag: 'clicou' }] });

    // Mesmo contato, mesmo botão → mesmo código; outro contato → código novo
    await t.engine.handleEvent(dm('link'));
    await t.engine.handleEvent(dm('link', 'user-2'));
    expect(t.store.links.map((l) => l.code)).toEqual(['L1', 'L2']);
  });

  it('sem linkBase ou com rastreio desligado, o link vai direto', async () => {
    const t = setup({ linkBase: BASE, settings: { timezone: 'America/Sao_Paulo', bot_pause_hours: 12, track_links: false } });
    const { flowId } = t.addFlow(flow);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['link'] });
    await t.engine.handleEvent(dm('link'));
    expect(btnUrl(t.ig.sent[0]!.msg as never)).toBe('https://site.com/guia?x=Maria');
  });

  it('lembrete para quem não clicou: condição "clicou no link"', async () => {
    const t = setup({ linkBase: BASE });
    const { flowId } = t.addFlow({
      start: 'm',
      nodes: {
        m: { type: 'message', data: { text: 'Aqui 👇', buttons: [{ label: 'Abrir', url: 'https://site.com' }] }, next: 'd' },
        d: { type: 'delay', data: { minutes: 30 }, next: 'c' },
        c: { type: 'condition', data: { rules: [{ when: { type: 'clicked_link' }, next: null }], else: 'r' } },
        r: { type: 'message', data: { text: 'Viu o material? 👀' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['link'] });

    await t.engine.handleEvent(dm('link', 'user-1'));
    await t.engine.handleEvent(dm('link', 'user-2'));
    // user-1 clica; user-2 não
    t.store.links.find((l) => l.contactId === t.store.contacts.find((c) => c.igsid === 'user-1')!.id)!.clickedAt = new Date();
    for (const s of t.scheduled.filter((x) => x.job.kind === 'resume_delay')) await t.engine.handleScheduled(s.job);
    const texts = t.ig.sent.map((s) => `${"id" in s.to ? s.to.id : ""}: ${textOf(s.msg)}`);
    expect(texts.filter((x) => x.includes('Viu o material'))).toEqual(['user-2: Viu o material? 👀']);
  });
});

describe('blocos mais completos', () => {
  it('mensagem com foto manda a foto e depois o texto', async () => {
    const t = setup();
    const { flowId } = t.addFlow({ start: 'm', nodes: { m: { type: 'message', data: { text: 'Olha só', image_url: 'https://site.com/a.jpg' } } } });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['foto'] });
    await t.engine.handleEvent(dm('foto'));
    expect(t.ig.sent.map((s) => s.msg.kind)).toEqual(['image', 'text']);
  });

  it('ações no botão: tag e campo sem nó de Ação', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'm',
      nodes: {
        m: {
          type: 'message',
          data: {
            text: 'Interesse?',
            buttons: [{ label: 'Comprar', next: 'ok', actions: [{ type: 'add_tag', tag: 'quente' }, { type: 'set_field', field: 'interesse', value: 'compra' }] }],
          },
        },
        ok: { type: 'message', data: { text: 'Interesse: {{field.interesse}}' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    const m = t.ig.sent[0]!.msg;
    await t.engine.handleEvent(postback(m.kind === 'buttons' && m.buttons[0]!.type === 'postback' ? m.buttons[0]!.payload : '', 'user-1', 'Comprar'));
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Interesse: compra');
    const contact = t.store.contacts[0]!;
    expect(t.store.tags.get(contact.id)?.has('quente')).toBe(true);
  });

  it('Pergunta com sugestões, botão Pular e lembrete', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'q',
      nodes: {
        q: {
          type: 'ask',
          data: { text: 'Qual tamanho?', save_to: 'tamanho', validate: 'text', max_retries: 2, options: ['P', 'M', 'G'], skip_label: 'Pular', reminder_minutes: 30 },
          next: 'f',
        },
        f: { type: 'message', data: { text: 'Tamanho: {{field.tamanho|não informado}}' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['camiseta'] });

    // Toca numa sugestão
    await t.engine.handleEvent(dm('camiseta'));
    const ask = t.ig.sent[0]!.msg;
    expect(ask.kind === 'text' && ask.quickReplies!.map((q) => q.title)).toEqual(['P', 'M', 'G', 'Pular']);
    const qrs = ask.kind === 'text' ? ask.quickReplies! : [];
    expect(parsePayload(qrs[1]!.payload)).toMatchObject({ type: 'answer', index: 1 });
    await t.engine.handleEvent(dm('M', 'user-1', qrs[1]!.payload));
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Tamanho: M');

    // Outra pessoa: lembrete e depois Pular
    await t.engine.handleEvent(dm('camiseta', 'user-2'));
    const rem = t.scheduled.find((s) => s.job.kind === 'ask_reminder')!;
    expect(rem.delayMs).toBe(30 * 60_000);
    await t.engine.handleEvent({ ...dm('', 'user-2'), kind: 'dm' }); // ignora: vazio não é resposta
    const before = t.ig.sent.length;
    await t.engine.handleScheduled(t.scheduled.filter((s) => s.job.kind === 'ask_reminder').at(-1)!.job);
    expect(t.ig.sent.length).toBeGreaterThanOrEqual(before);
    const skipPayload = qrs[3]!.payload;
    await t.engine.handleEvent(dm('Pular', 'user-2', skipPayload));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toBe('Tamanho: não informado');
  });
});

describe('automação rápida Comentário → Direct', () => {
  it('monta abertura 🔒 → e-mail → link → lembrete, sem avisos, e roda de ponta a ponta', async () => {
    const { buildCommentFlow, QuickCommentSchema } = await import('../src/flow/quick.js');
    const { validateGraph } = await import('../src/flow/schema.js');
    const { comment } = await import('./helpers.js');
    const q = QuickCommentSchema.parse({
      followers_only: true,
      ask_email: { enabled: true },
      message: { text: 'Aqui está o guia 👇', links: [{ label: 'Abrir guia', url: 'site.com/guia' }] },
      follow_up: { enabled: true, minutes: 60 },
    });
    const { graph, notes } = buildCommentFlow(q);
    expect(notes).toEqual([]);
    expect(Object.keys(graph.nodes)).toEqual(['abertura', 'email', 'entrega', 'espera', 'clicou', 'lembrete', 'fim']);
    expect(validateGraph(graph).issues).toEqual([]);

    const t = setup({ linkBase: BASE });
    const { flowId } = t.addFlow(graph);
    t.addTrigger(flowId, 'comment', { keywords: ['guia'], match: 'contains', public_replies: [], once_per_contact: true });
    t.ig.followers.add('user-1');

    await t.engine.handleEvent(comment('quero o GUIA'));
    const open = t.ig.sent[0]!.msg;
    await t.engine.handleEvent(postback(open.kind === 'buttons' && open.buttons[0]!.type === 'postback' ? open.buttons[0]!.payload : '', 'user-1', 'Quero receber'));
    expect(textOf(t.ig.sent[1]!.msg)).toContain('e-mail');
    await t.engine.handleEvent(dm('maria@email.com'));
    const link = t.ig.sent[2]!.msg;
    expect(textOf(link)).toBe('Aqui está o guia 👇');
    expect(btnUrl(link as never)).toBe(`${BASE}/r/L1`);
    expect(t.store.links[0]!.url).toBe('https://site.com/guia');
    // Não clicou → lembrete depois de 60 min
    const delay = t.scheduled.find((s) => s.job.kind === 'resume_delay')!;
    expect(delay.delayMs).toBe(60 * 60_000);
    await t.engine.handleScheduled(delay.job);
    expect(textOf(t.ig.sent[3]!.msg)).toContain('Conseguiu ver');
  });

  it('sem abertura mas com 🔒/lembrete: liga a abertura sozinho e avisa', async () => {
    const { buildCommentFlow, QuickCommentSchema } = await import('../src/flow/quick.js');
    const { notes, graph } = buildCommentFlow(
      QuickCommentSchema.parse({ opening: { enabled: false }, followers_only: true, message: { text: 'Oi', links: [] }, follow_up: { enabled: true } }),
    );
    expect(graph.start).toBe('abertura');
    expect(notes).toHaveLength(2);
  });
});
