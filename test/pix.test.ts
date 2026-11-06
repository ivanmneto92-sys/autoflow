import { describe, expect, it } from 'vitest';
import type { PaymentGateway } from '../src/payments/gateway.js';
import { Asaas, MercadoPago, PaymentError } from '../src/payments/providers.js';
import { dm, setup, textOf } from './helpers.js';

class FakeGateway implements PaymentGateway {
  created: Parameters<PaymentGateway['create']>[0][] = [];
  status: 'pending' | 'paid' | 'expired' = 'pending';
  fail = false;
  async create(i: Parameters<PaymentGateway['create']>[0]) {
    if (this.fail) throw new Error('Nenhuma conta de Pix conectada');
    this.created.push(i);
    return { paymentId: `pay-${this.created.length}`, qrCode: '00020126PIXCOPIAECOLA', ticketUrl: 'https://mp.test/qr' };
  }
  async refresh() {
    return this.status;
  }
}

const graph = {
  start: 'c',
  nodes: {
    c: { type: 'charge' as const, data: { amount: '{{field.total}}', description: 'Pedido #{{var.n}}', expires_minutes: 30, text: 'Paga aqui 👇', on_expired: 'x' }, next: 'ok' },
    ok: { type: 'message' as const, data: { text: 'Pagamento confirmado! ✅' } },
    x: { type: 'message' as const, data: { text: 'O Pix venceu.' } },
  },
};

function withPix(gw?: FakeGateway) {
  const t = setup();
  (t.engine as unknown as { deps: { payments?: PaymentGateway } }).deps.payments = gw;
  const { flowId } = t.addFlow(graph);
  t.addTrigger(flowId, 'dm_keyword', { keywords: ['pagar'] });
  return t;
}

describe('nó Cobrar Pix', () => {
  it('manda o valor, o botão do QR e o copia-e-cola; pago → segue o caminho de pago', async () => {
    const gw = new FakeGateway();
    const t = withPix(gw);
    await t.engine.handleEvent(dm('pagar'));
    // sem total no contato → valor inválido: avisa e segue "não pagou"
    expect(textOf(t.ig.sent.at(-2)!.msg)).toContain('Não consegui gerar o Pix');

    const t2 = withPix(gw);
    const contactFields = (id: string) => t2.store.fields.set(id, { total: '59,90', nome: 'Ana', cpf: '123.456.789-09' });
    await t2.engine.handleEvent(dm('oi'));
    contactFields(t2.store.contacts[0]!.id);
    await t2.engine.handleEvent(dm('pagar'));
    const [first, qr] = t2.ig.sent.slice(-2);
    expect(first!.msg.kind).toBe('buttons');
    expect(textOf(first!.msg)).toContain('R$ 59,90');
    expect(textOf(qr!.msg)).toBe('00020126PIXCOPIAECOLA');
    expect(gw.created.at(-1)).toMatchObject({ amountCents: 5990, contact: { name: 'Ana', cpf: '123.456.789-09' }, simulator: false });
    const session = t2.store.sessions.at(-1)!;
    expect(session.status).toBe('waiting_payment');

    // cliente escreve "paguei" → agenda conferência
    await t2.engine.handleEvent(dm('paguei'));
    expect(t2.scheduled.some((s) => s.job.kind === 'payment_update')).toBe(true);

    gw.status = 'paid';
    await t2.engine.handleScheduled({ kind: 'payment_update', sessionId: session.id, paymentId: 'pay-1' });
    expect(textOf(t2.ig.sent.at(-1)!.msg)).toBe('Pagamento confirmado! ✅');
    // repetido não faz nada
    const n = t2.ig.sent.length;
    await t2.engine.handleScheduled({ kind: 'payment_update', sessionId: session.id, paymentId: 'pay-1' });
    expect(t2.ig.sent.length).toBe(n);
  });

  it('venceu → segue "não pagou"; sem conta de Pix → avisa e segue "não pagou"', async () => {
    const gw = new FakeGateway();
    const t = withPix(gw);
    await t.engine.handleEvent(dm('oi'));
    t.store.fields.set(t.store.contacts[0]!.id, { total: '10' });
    await t.engine.handleEvent(dm('pagar'));
    const session = t.store.sessions.at(-1)!;
    gw.status = 'expired';
    await t.engine.handleScheduled({ kind: 'payment_update', sessionId: session.id, paymentId: 'pay-1' });
    expect(textOf(t.ig.sent.at(-1)!.msg)).toBe('O Pix venceu.');

    const noGw = new FakeGateway();
    noGw.fail = true;
    const t2 = withPix(noGw);
    await t2.engine.handleEvent(dm('oi'));
    t2.store.fields.set(t2.store.contacts[0]!.id, { total: '10' });
    await t2.engine.handleEvent(dm('pagar'));
    const texts = t2.ig.sent.map((s) => textOf(s.msg));
    expect(texts.at(-2)).toContain('Não consegui gerar o Pix');
    expect(texts.at(-1)).toBe('O Pix venceu.');
  });
});

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('provedores de Pix', () => {
  it('Mercado Pago: cria Pix com valor, vencimento, notificação e lê o status', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const mp = new MercadoPago('APP_USR-x', async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/v1/payments'))
        return res(201, { id: 123, status: 'pending', point_of_interaction: { transaction_data: { qr_code: 'PIXCODE', ticket_url: 'https://mp/qr' } } });
      return res(200, { id: 123, status: 'approved' });
    });
    const out = await mp.createPix({
      amountCents: 4990,
      description: 'Pedido #7',
      externalRef: 'ref-uuid',
      expiresAt: new Date('2026-11-06T15:00:00Z'),
      payer: { id: 'contact-1234567', name: 'Ana Souza', cpf: '123.456.789-09' },
      notificationUrl: 'https://api.test/webhooks/mercadopago/ws',
    });
    expect(out).toEqual({ providerId: '123', qrCode: 'PIXCODE', ticketUrl: 'https://mp/qr' });
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({
      transaction_amount: 49.9,
      payment_method_id: 'pix',
      external_reference: 'ref-uuid',
      date_of_expiration: '2026-11-06T12:00:00.000-03:00',
      notification_url: 'https://api.test/webhooks/mercadopago/ws',
      payer: { first_name: 'Ana', identification: { type: 'CPF', number: '12345678909' } },
    });
    expect((calls[0]!.init!.headers as Record<string, string>)['X-Idempotency-Key']).toBe('ref-uuid');
    expect(await mp.getStatus('123')).toBe('paid');
  });

  it('Mercado Pago: chave inválida vira mensagem clara', async () => {
    const mp = new MercadoPago('x', async () => res(401, { message: 'invalid access token' }));
    await expect(mp.verify()).rejects.toThrow(/chave da API inválida/);
  });

  it('Asaas: exige CPF, cria cliente e cobrança Pix', async () => {
    const asaas = new Asaas('key', true, async (url, init) => {
      const u = String(url);
      expect(u.startsWith('https://api-sandbox.asaas.com/v3')).toBe(true);
      if (u.includes('/customers?')) return res(200, { data: [] });
      if (u.endsWith('/customers')) return res(200, { id: 'cus_1' });
      if (u.endsWith('/payments') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({ customer: 'cus_1', billingType: 'PIX', value: 10 });
        return res(200, { id: 'pay_1', invoiceUrl: 'https://asaas/i/1' });
      }
      if (u.endsWith('/pixQrCode')) return res(200, { payload: 'ASAASPIX' });
      return res(200, { status: 'RECEIVED' });
    });
    const base = { amountCents: 1000, description: 'x', externalRef: 'r', expiresAt: new Date(), payer: { id: 'c1', name: 'Ana' } };
    await expect(asaas.createPix(base)).rejects.toBeInstanceOf(PaymentError);
    expect(await asaas.createPix({ ...base, payer: { ...base.payer, cpf: '12345678909' } })).toEqual({
      providerId: 'pay_1',
      qrCode: 'ASAASPIX',
      ticketUrl: 'https://asaas/i/1',
    });
    expect(await asaas.getStatus('pay_1')).toBe('paid');
  });
});
