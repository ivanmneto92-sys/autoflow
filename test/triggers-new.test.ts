import { describe, expect, it } from 'vitest';
import { parseTriggerConfig } from '../src/flow/triggers.js';
import { normalizeWebhook } from '../src/instagram/webhook.js';
import { dm, IG_BIZ, setup, textOf } from './helpers.js';

const flowWith = (t: ReturnType<typeof setup>, text: string) => t.addFlow({ start: 'a', nodes: { a: { type: 'message', data: { text } } } }).flowId;
let n = 0;
const storyReply = (text: string, senderId = 'user-1') => ({ ...dm(text, senderId), storyReply: { id: 'story-1', url: 'https://cdn/x' } });
const refEvent = (ref: string, senderId = 'user-1') => ({
  kind: 'referral' as const,
  igUserId: IG_BIZ,
  senderId,
  mid: `ref_${++n}`,
  referral: { ref, source: 'IGME_SOURCE_LINK' },
  timestamp: Date.now(),
});

describe('webhook: novos eventos', () => {
  it('reconhece resposta a story, anúncio e link ig.me', () => {
    const events = normalizeWebhook({
      object: 'instagram',
      entry: [
        {
          id: IG_BIZ,
          messaging: [
            { sender: { id: 'u1' }, recipient: { id: IG_BIZ }, timestamp: 1, message: { mid: 'm1', text: '🔥', reply_to: { story: { id: 's1', url: 'https://cdn/s1' } } } },
            { sender: { id: 'u2' }, recipient: { id: IG_BIZ }, timestamp: 2, message: { mid: 'm2', text: 'oi', referral: { ref: 'promo', ad_id: 123, source: 'ADS', type: 'OPEN_THREAD' } } },
            { sender: { id: 'u3' }, recipient: { id: IG_BIZ }, timestamp: 3, referral: { ref: 'cardapio', source: 'IGME_SOURCE_LINK', type: 'OPEN_THREAD' } },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({ kind: 'dm', storyReply: { id: 's1', url: 'https://cdn/s1' } });
    expect(events[1]).toMatchObject({ kind: 'dm', referral: { ref: 'promo', adId: '123', source: 'ADS' } });
    expect(events[2]).toMatchObject({ kind: 'referral', senderId: 'u3', referral: { ref: 'cardapio' } });
  });
});

describe('gatilho: resposta ao story', () => {
  it('dispara com qualquer resposta ou com palavra-chave; DM comum não dispara', async () => {
    const t = setup();
    t.addTrigger(flowWith(t, 'Vi que você respondeu o story!'), 'story_reply', {});
    await t.engine.handleEvent(dm('oi'));
    expect(t.ig.sent).toHaveLength(0);
    await t.engine.handleEvent(storyReply('😍', 'user-2'));
    expect(textOf(t.ig.sent[0]!.msg)).toContain('story');

    const t2 = setup();
    t2.addTrigger(flowWith(t2, 'Promo!'), 'story_reply', { keywords: ['quero'] });
    await t2.engine.handleEvent(storyReply('lindo'));
    expect(t2.ig.sent).toHaveLength(0);
    await t2.engine.handleEvent(storyReply('eu quero', 'user-3'));
    expect(t2.ig.sent).toHaveLength(1);
  });
});

describe('gatilho: link ig.me com ref', () => {
  it('dispara o fluxo do ref certo (sem diferenciar maiúsculas) e ignora ref desconhecido', async () => {
    const t = setup();
    t.addTrigger(flowWith(t, 'Cardápio aqui'), 'ref_link', { ref: 'cardapio' });
    t.addTrigger(flowWith(t, 'Promo aqui'), 'ref_link', { ref: 'promo' });
    t.addTrigger(flowWith(t, 'Resposta padrão'), 'default_reply', {});
    await t.engine.handleEvent(refEvent('PROMO'));
    expect(textOf(t.ig.sent[0]!.msg)).toBe('Promo aqui');
    await t.engine.handleEvent(refEvent('outro', 'user-9'));
    expect(t.ig.sent).toHaveLength(1); // só abrir a conversa não dispara resposta padrão
  });

  it('primeira mensagem vinda do link (ref dentro da mensagem) também dispara', async () => {
    const t = setup();
    t.addTrigger(flowWith(t, 'Bem-vindo pelo link'), 'ref_link', { ref: 'bio' });
    await t.engine.handleEvent({ ...dm('Olá'), referral: { ref: 'bio', source: 'IGME_SOURCE_LINK' } });
    expect(textOf(t.ig.sent[0]!.msg)).toBe('Bem-vindo pelo link');
  });

  it('valida o ref', () => {
    expect(() => parseTriggerConfig('ref_link', { ref: 'tem espaço' })).toThrow();
    expect(parseTriggerConfig('ref_link', { ref: ' promo-1 ' })).toEqual({ ref: 'promo-1' });
  });
});

describe('gatilho: clique em anúncio', () => {
  it('anúncio específico vence o de "qualquer anúncio"', async () => {
    const t = setup();
    t.addTrigger(flowWith(t, 'Qualquer anúncio'), 'ad_click', {});
    t.addTrigger(flowWith(t, 'Anúncio 123'), 'ad_click', { ad_id: '123' });
    await t.engine.handleEvent({ ...dm('oi'), referral: { source: 'ADS', adId: '123' } });
    expect(textOf(t.ig.sent[0]!.msg)).toBe('Anúncio 123');
    await t.engine.handleEvent({ ...dm('oi', 'user-2'), referral: { source: 'ADS', adId: '999' } });
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Qualquer anúncio');
  });
});

describe('condição: segue a conta', () => {
  it('modelo "Só para seguidores": não segue → pede para seguir; segue → entrega', async () => {
    const { readFileSync } = await import('node:fs');
    const { validateGraph } = await import('../src/flow/schema.js');
    const tpl = JSON.parse(readFileSync('templates/seguidores.json', 'utf8'));
    expect(validateGraph(tpl.flow).issues.filter((i) => i.level === 'error')).toEqual([]);

    const t = setup();
    const { flowId } = t.addFlow(tpl.flow);
    for (const tr of tpl.triggers) t.addTrigger(flowId, tr.type, tr.config, tr.priority);
    const { comment, postback } = await import('./helpers.js');

    await t.engine.handleEvent(comment('eu quero!'));
    const first = t.ig.sent[0]!.msg;
    expect(first.kind).toBe('buttons');
    const payload = first.kind === 'buttons' && first.buttons[0]!.type === 'postback' ? first.buttons[0]!.payload : '';

    // Ainda não segue
    await t.engine.handleEvent(postback(payload, 'user-1', 'Quero receber'));
    expect(textOf(t.ig.sent[1]!.msg)).toContain('Ainda não encontrei você');
    const again = t.ig.sent[1]!.msg;
    const payload2 = again.kind === 'buttons' && again.buttons[0]!.type === 'postback' ? again.buttons[0]!.payload : '';

    // Seguiu e clicou de novo
    t.ig.followers.add('user-1');
    await t.engine.handleEvent(postback(payload2, 'user-1', 'Pronto, já sigo'));
    expect(textOf(t.ig.sent[2]!.msg)).toContain('Obrigado por me seguir');
  });

  it('sem consentimento da Meta: trata como "não segue" e registra o motivo', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'c',
      nodes: {
        c: { type: 'condition', data: { rules: [{ when: { type: 'is_follower' }, next: 's' }], else: 'n' } },
        s: { type: 'message', data: { text: 'segue' } },
        n: { type: 'message', data: { text: 'nao segue' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    t.ig.followError = true;
    await t.engine.handleEvent(dm('oi'));
    expect(textOf(t.ig.sent[0]!.msg)).toBe('nao segue');
    expect(t.store.events.some((e: { type: string }) => e.type === 'follow_check_failed')).toBe(true);
  });
});
