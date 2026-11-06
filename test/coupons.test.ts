import { describe, expect, it } from 'vitest';
import { generateCode, normalizePrefix, parseCodeList } from '../src/lib/coupon.js';
import { validateGraph } from '../src/flow/schema.js';
import { dm, setup, textOf } from './helpers.js';

const CAMP = '7b0c7b6e-1c1a-4c7e-9a51-5f5d1c9a0001';

const couponFlow = {
  start: 'a',
  nodes: {
    a: { type: 'action', data: { actions: [{ type: 'give_coupon', campaign_id: CAMP }] }, next: 'c' },
    c: {
      type: 'condition',
      data: {
        rules: [
          { when: { type: 'var_equals', var: 'coupon_status', value: 'esgotado' }, next: 'fim' },
          { when: { type: 'var_equals', var: 'coupon_status', value: 'ja_tinha' }, next: 'rep' },
        ],
        else: 'ok',
      },
    },
    ok: { type: 'message', data: { text: 'Seu cupom: {{var.coupon_code}} ({{var.coupon_discount}}) até {{var.coupon_expires}}' } },
    rep: { type: 'message', data: { text: 'Você já pegou: {{var.coupon_code}}' } },
    fim: { type: 'message', data: { text: 'Acabaram os cupons 😢' } },
  },
};

describe('códigos de cupom', () => {
  it('gera com prefixo limpo e sem caracteres ambíguos', () => {
    expect(normalizePrefix(' Pizzaria São-João ')).toBe('PIZZARIASAOJ');
    const c = generateCode('promo');
    expect(c).toMatch(/^PROMO-[A-HJ-NP-Z2-9]{6}$/);
    expect(new Set(Array.from({ length: 200 }, () => generateCode('X'))).size).toBe(200);
  });

  it('lê a lista colada (linhas, vírgulas) sem repetir', () => {
    expect(parseCodeList('ABC1\nabc1, DEF2 ;GHI3\n\n')).toEqual(['ABC1', 'DEF2', 'GHI3']);
  });

  it('ação exige escolher a campanha', () => {
    const bad = validateGraph({ start: 'a', nodes: { a: { type: 'action', data: { actions: [{ type: 'give_coupon', campaign_id: '' }] } } } });
    expect(bad.issues.filter((i) => i.level === 'error').map((i) => i.message).join()).toContain('Escolha a campanha');
    const good = validateGraph({ start: 'a', nodes: { a: { type: 'action', data: { actions: [{ type: 'give_coupon', campaign_id: CAMP }] } } } });
    expect(good.issues.filter((i) => i.level === 'error')).toEqual([]);
  });
});

describe('ação: entregar cupom', () => {
  it('cada pessoa recebe um código só dela; repetir devolve o mesmo', async () => {
    const t = setup();
    t.store.couponCampaigns.push({ id: CAMP, workspaceId: 'ws-1', mode: 'generated', prefix: 'PIZZA', discount: '10% OFF', validDays: 7 });
    const { flowId } = t.addFlow(couponFlow as never);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['cupom'] });

    await t.engine.handleEvent(dm('cupom', 'user-1'));
    await t.engine.handleEvent(dm('cupom', 'user-2'));
    await t.engine.handleEvent(dm('cupom', 'user-1'));
    const texts = t.ig.sent.map((s) => textOf(s.msg));
    expect(texts[0]).toMatch(/^Seu cupom: PIZZA-\d+ \(10% OFF\) até \d{2}\/\d{2}\/\d{4}$/);
    expect(texts[1]).toMatch(/^Seu cupom: PIZZA-/);
    expect(texts[0]).not.toBe(texts[1]);
    const code1 = texts[0]!.split(' ')[2];
    expect(texts[2]).toBe(`Você já pegou: ${code1}`);
    expect(t.store.events.filter((e: { type: string }) => e.type === 'coupon_given')).toHaveLength(2);
  });

  it('lista importada: entrega na ordem e avisa quando acaba', async () => {
    const t = setup();
    t.store.couponCampaigns.push({ id: CAMP, workspaceId: 'ws-1', mode: 'list', prefix: '', discount: 'Frete grátis', validDays: null });
    t.store.coupons.push({ campaignId: CAMP, code: 'LOJA-AAA', contactId: null, expiresAt: null });
    const { flowId } = t.addFlow(couponFlow as never);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['cupom'] });

    await t.engine.handleEvent(dm('cupom', 'user-1'));
    await t.engine.handleEvent(dm('cupom', 'user-2'));
    expect(textOf(t.ig.sent[0]!.msg)).toBe('Seu cupom: LOJA-AAA (Frete grátis) até ');
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Acabaram os cupons 😢');
  });
});
