import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../src/flow/schema.js';
import { comment, dm, loadTemplate, postback, setup, textOf } from './helpers.js';

describe('Comentário → DM', () => {
  it('responde em público, manda DM privada com botões e continua pelo clique', async () => {
    const t = setup();
    const tpl = loadTemplate();
    const { flowId } = t.addFlow(tpl.flow);
    for (const tr of tpl.triggers) t.addTrigger(flowId, tr.type, tr.config, tr.priority);

    const c = comment('Quero o cardápio!');
    await t.engine.handleEvent(c);

    expect(t.ig.publicReplies).toHaveLength(1);
    expect(t.ig.sent).toHaveLength(1);
    expect(t.ig.sent[0]!.to).toEqual({ comment_id: c.commentId });
    const first = t.ig.sent[0]!.msg;
    expect(first.kind).toBe('buttons');
    if (first.kind !== 'buttons') return;

    // Cliente clica em "Ver cardápio"
    const btn = first.buttons[0]!;
    expect(btn.type).toBe('postback');
    await t.engine.handleEvent(postback(btn.type === 'postback' ? btn.payload : '', 'user-1', 'Ver cardápio'));

    expect(t.ig.sent).toHaveLength(2);
    expect(t.ig.sent[1]!.to).toEqual({ id: 'user-1' });
    expect(textOf(t.ig.sent[1]!.msg)).toContain('cardápio');
  });

  it('ignora comentários sem palavra-chave e da própria conta', async () => {
    const t = setup();
    const { flowId } = t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text: 'oi' } } } });
    t.addTrigger(flowId, 'comment', { keywords: ['eu quero'] });
    await t.engine.handleEvent(comment('que lindo'));
    await t.engine.handleEvent(comment('eu quero', t.account.igUserId));
    expect(t.ig.sent).toHaveLength(0);
    await t.engine.handleEvent(comment('EU QUERO!!!'));
    expect(t.ig.sent).toHaveLength(1);
  });

  it('filtra por post e respeita "uma vez por contato"', async () => {
    const t = setup();
    const { flowId } = t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text: 'oi' } } } });
    t.addTrigger(flowId, 'comment', { media_id: 'media-9', once_per_contact: true });
    await t.engine.handleEvent(comment('qualquer', 'user-1', 'media-1'));
    expect(t.ig.sent).toHaveLength(0);
    await t.engine.handleEvent(comment('qualquer', 'user-1', 'media-9'));
    await t.engine.handleEvent(comment('de novo', 'user-1', 'media-9'));
    expect(t.ig.sent).toHaveLength(1);
  });

  it('segunda mensagem espera a janela abrir (cliente responder)', async () => {
    const t = setup();
    const graph: FlowGraph = {
      start: 'a',
      nodes: {
        a: { type: 'message', data: { text: 'primeira' }, next: 'b' },
        b: { type: 'message', data: { text: 'segunda' } },
      },
    };
    const { flowId } = t.addFlow(graph);
    t.addTrigger(flowId, 'comment', {});
    await t.engine.handleEvent(comment('oi'));
    expect(t.ig.sent.map((s) => textOf(s.msg))).toEqual(['primeira']);
    const contact = t.store.contacts[0]!;
    expect((await t.store.getActiveSession(contact.id))?.status).toBe('waiting_window');

    await t.engine.handleEvent(dm('opa'));
    expect(t.ig.sent.map((s) => textOf(s.msg))).toEqual(['primeira', 'segunda']);
    expect(t.ig.sent[1]!.to).toEqual({ id: 'user-1' });
  });
});

describe('DM, perguntas e atendimento humano', () => {
  it('fluxo de pedido do template: coleta, valida telefone e registra o pedido', async () => {
    const t = setup(); // sexta 19h → aberto
    const tpl = loadTemplate();
    const { flowId } = t.addFlow(tpl.flow);
    for (const tr of tpl.triggers) t.addTrigger(flowId, tr.type, tr.config, tr.priority);
    t.account.settings.business_hours = { fri: [['18:00', '23:59']] };

    await t.engine.handleEvent(dm('oii, quero fazer um pedido'));
    const welcome = t.ig.sent.at(-1)!.msg;
    expect(textOf(welcome)).toContain('Maria'); // nome do perfil
    if (welcome.kind !== 'buttons') throw new Error('esperava botões');
    const pedir = welcome.buttons[1]!;
    await t.engine.handleEvent(postback(pedir.type === 'postback' ? pedir.payload : ''));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toContain('Qual é o seu nome');

    await t.engine.handleEvent(dm('Maria'));
    await t.engine.handleEvent(dm('Rua A, 123 - Centro'));
    await t.engine.handleEvent(dm('telefone?'));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toContain('DDD');
    await t.engine.handleEvent(dm('(31) 99999-8888'));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toContain('o que vai querer');
    await t.engine.handleEvent(dm('1 pizza calabresa grande'));
    await t.engine.handleEvent(dm('Pix'));

    const contact = t.store.contacts[0]!;
    expect(await t.store.getFields(contact.id)).toEqual({
      nome: 'Maria',
      endereco: 'Rua A, 123 - Centro',
      telefone: '31999998888',
      pedido: '1 pizza calabresa grande',
      pagamento: 'Pix',
    });
    expect(await t.store.getTags(contact.id)).toEqual(expect.arrayContaining(['pedido-feito']));
    expect(t.store.orders[0]).toMatchObject({
      number: 1,
      summary: '1 pizza calabresa grande',
      details: [
        { label: 'nome', value: 'Maria' },
        { label: 'endereco', value: 'Rua A, 123 - Centro' },
        { label: 'telefone', value: '31999998888' },
        { label: 'pagamento', value: 'Pix' },
      ],
    });
    const confirm = textOf(t.ig.sent.at(-1)!.msg);
    expect(confirm).toContain('Pedido #1 recebido');
    expect(confirm).toContain('Rua A, 123');
  });

  it('fora do horário responde que está fechado', async () => {
    const t = setup({ now: new Date('2026-11-06T13:00:00Z') }); // sexta 10h SP
    const tpl = loadTemplate();
    const { flowId, version } = t.addFlow(tpl.flow);
    t.account.settings.business_hours = { fri: [['18:00', '23:59']] };
    await t.engine.handleEvent(postback(`af:b:${version.id}:boas_vindas:1`));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toContain('fechados');
    expect(flowId).toBeTruthy();
  });

  it('mensagem enviada por humano no app pausa o robô', async () => {
    const t = setup();
    const { flowId } = t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text: 'auto' } } } });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    expect(t.ig.sent).toHaveLength(1);

    // eco da mensagem do bot → não pausa
    await t.engine.handleEvent({ kind: 'echo', igUserId: t.account.igUserId, recipientId: 'user-1', mid: t.ig.sent.length ? (t.store.messages.find((m) => m.source === 'bot')?.mid as string) : '', timestamp: 0 });
    expect(t.store.contacts[0]!.botPausedUntil).toBeNull();

    // eco de mensagem digitada por humano → pausa
    await t.engine.handleEvent({ kind: 'echo', igUserId: t.account.igUserId, recipientId: 'user-1', mid: 'm_human', text: 'Oi! Aqui é o João', timestamp: 0 });
    expect(t.store.contacts[0]!.botPausedUntil).not.toBeNull();
    await t.engine.handleEvent(dm('oi'));
    expect(t.ig.sent).toHaveLength(1);
  });

  it('resposta padrão respeita cooldown', async () => {
    const t = setup();
    const { flowId } = t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text: 'padrão' } } } });
    t.addTrigger(flowId, 'default_reply', { cooldown_minutes: 60 });
    await t.engine.handleEvent(dm('blabla'));
    await t.engine.handleEvent(dm('blabla 2'));
    expect(t.ig.sent).toHaveLength(1);
    t.advance(61 * 60_000);
    await t.engine.handleEvent(dm('blabla 3'));
    expect(t.ig.sent).toHaveLength(2);
  });

  it('respostas rápidas continuam o fluxo', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'a',
      nodes: {
        a: { type: 'message', data: { text: 'Delivery ou retirada?', quick_replies: [{ label: 'Delivery', next: 'd' }, { label: 'Retirada', next: 'r' }] } },
        d: { type: 'message', data: { text: 'delivery!' } },
        r: { type: 'message', data: { text: 'retirada!' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['pedido'] });
    await t.engine.handleEvent(dm('pedido'));
    const qr = t.ig.sent[0]!.msg;
    if (qr.kind !== 'text' || !qr.quickReplies) throw new Error('esperava quick replies');
    await t.engine.handleEvent(dm('Retirada', 'user-1', qr.quickReplies[1]!.payload));
    expect(textOf(t.ig.sent.at(-1)!.msg)).toBe('retirada!');
  });
});

describe('Agendamentos e limites', () => {
  it('nó de atraso agenda e retoma', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'a',
      nodes: {
        a: { type: 'message', data: { text: 'já volto' }, next: 'w' },
        w: { type: 'delay', data: { minutes: 10 }, next: 'b' },
        b: { type: 'message', data: { text: 'voltei' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    expect(t.scheduled).toHaveLength(1);
    expect(t.scheduled[0]!.delayMs).toBe(600_000);
    t.advance(600_000);
    await t.engine.handleScheduled(t.scheduled[0]!.job);
    expect(t.ig.sent.map((s) => textOf(s.msg))).toEqual(['já volto', 'voltei']);
    // job repetido não reexecuta
    await t.engine.handleScheduled(t.scheduled[0]!.job);
    expect(t.ig.sent).toHaveLength(2);
  });

  it('timeout de pergunta segue para on_timeout', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'q',
      nodes: {
        q: { type: 'ask', data: { text: 'email?', save_to: 'email', validate: 'email', max_retries: 2, timeout_minutes: 5, on_timeout: 'x' }, next: 'ok' },
        ok: { type: 'message', data: { text: 'valeu' } },
        x: { type: 'message', data: { text: 'sumiu?' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    await t.engine.handleScheduled(t.scheduled[0]!.job);
    expect(textOf(t.ig.sent.at(-1)!.msg)).toBe('sumiu?');
  });

  it('cota estourada adia o envio para a próxima hora', async () => {
    const t = setup({ quota: false });
    const { flowId } = t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text: 'oi' } } } });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    expect(t.ig.sent).toHaveLength(0);
    expect(t.scheduled[0]!.job.kind).toBe('resume_quota');
    expect((await t.store.getActiveSession(t.store.contacts[0]!.id))?.status).toBe('waiting_delay');
  });

  it('protege contra loop infinito', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'a',
      nodes: { a: { type: 'action', data: { actions: [{ type: 'set_var', var: 'x', value: '1' }] }, next: 'a' } },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    expect(t.store.sessions[0]!.status).toBe('failed');
  });
});
