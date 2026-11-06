/**
 * Integrações de Pix. Cada negócio usa a própria conta (a chave fica criptografada em payment_accounts).
 *  - Mercado Pago: POST /v1/payments (payment_method_id = pix) → QR "copia e cola" + link do QR.
 *  - Asaas: cliente (com CPF/CNPJ) → POST /v3/payments (billingType = PIX) → /pixQrCode.
 */
export type ProviderName = 'mercadopago' | 'asaas';
export type PixStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface CreatePixInput {
  amountCents: number;
  description: string;
  externalRef: string;
  expiresAt: Date;
  payer: { id: string; name?: string | null; email?: string | null; cpf?: string | null };
  notificationUrl?: string;
}

export interface CreatedPix {
  providerId: string;
  qrCode: string;
  ticketUrl?: string;
}

export interface PixProvider {
  createPix(input: CreatePixInput): Promise<CreatedPix>;
  getStatus(providerId: string): Promise<PixStatus>;
  /** Confere a chave e devolve um nome para mostrar no painel. */
  verify(): Promise<string>;
}

export class PaymentError extends Error {}

type Fetch = typeof fetch;

async function readJson(res: Response, what: string): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      body?.message ?? body?.errors?.[0]?.description ?? body?.cause?.[0]?.description ?? body?.error ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new PaymentError(`${what}: chave da API inválida ou sem permissão`);
    throw new PaymentError(`${what}: ${msg}`);
  }
  return body;
}

const onlyDigits = (s?: string | null) => (s ?? '').replace(/\D/g, '');

/** Data no fuso de Brasília no formato do Mercado Pago (yyyy-MM-ddTHH:mm:ss.000-03:00). */
function brTime(d: Date): string {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return local.toISOString().replace('Z', '-03:00');
}

export class MercadoPago implements PixProvider {
  constructor(
    private token: string,
    private doFetch: Fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...extra };
  }

  async createPix(i: CreatePixInput): Promise<CreatedPix> {
    const email = i.payer.email && /.+@.+\..+/.test(i.payer.email) ? i.payer.email : `cliente.${i.payer.id.slice(0, 8)}@autoflow.a2bads.com.br`;
    const res = await this.doFetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: this.headers({ 'X-Idempotency-Key': i.externalRef }),
      body: JSON.stringify({
        transaction_amount: i.amountCents / 100,
        description: i.description.slice(0, 120) || 'Pagamento',
        payment_method_id: 'pix',
        external_reference: i.externalRef,
        date_of_expiration: brTime(i.expiresAt),
        ...(i.notificationUrl ? { notification_url: i.notificationUrl } : {}),
        payer: {
          email,
          ...(i.payer.name ? { first_name: i.payer.name.split(' ')[0] } : {}),
          ...(onlyDigits(i.payer.cpf).length === 11 ? { identification: { type: 'CPF', number: onlyDigits(i.payer.cpf) } } : {}),
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res, 'Mercado Pago');
    const tx = body?.point_of_interaction?.transaction_data;
    if (!tx?.qr_code) throw new PaymentError('Mercado Pago não devolveu o código Pix. Confira se a conta tem chave Pix cadastrada.');
    return { providerId: String(body.id), qrCode: tx.qr_code, ticketUrl: tx.ticket_url };
  }

  async getStatus(id: string): Promise<PixStatus> {
    const res = await this.doFetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(res, 'Mercado Pago');
    if (body.status === 'approved') return 'paid';
    if (body.status === 'cancelled' || body.status === 'rejected') return 'cancelled';
    if (body.status === 'refunded' || body.status === 'charged_back') return 'cancelled';
    return 'pending';
  }

  async verify(): Promise<string> {
    const res = await this.doFetch('https://api.mercadopago.com/users/me', { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    const body = await readJson(res, 'Mercado Pago');
    return String(body.nickname ?? body.email ?? body.id ?? 'conta conectada');
  }
}

export class Asaas implements PixProvider {
  private base: string;
  constructor(
    private token: string,
    sandbox: boolean,
    private doFetch: Fetch = fetch,
  ) {
    this.base = sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
  }

  private req(path: string, init: RequestInit = {}) {
    return this.doFetch(`${this.base}${path}`, {
      ...init,
      headers: { access_token: this.token, 'Content-Type': 'application/json', 'User-Agent': 'autoflow', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  }

  private async customer(p: CreatePixInput['payer']): Promise<string> {
    const found = await readJson(await this.req(`/customers?externalReference=${encodeURIComponent(p.id)}&limit=1`), 'Asaas');
    if (found?.data?.[0]?.id) return found.data[0].id as string;
    const doc = onlyDigits(p.cpf);
    if (doc.length !== 11 && doc.length !== 14)
      throw new PaymentError('O Asaas exige o CPF do cliente para gerar o Pix. Peça o CPF antes (campo "cpf") ou use o Mercado Pago.');
    const created = await readJson(
      await this.req('/customers', { method: 'POST', body: JSON.stringify({ name: p.name || 'Cliente Instagram', cpfCnpj: doc, externalReference: p.id }) }),
      'Asaas',
    );
    return created.id as string;
  }

  async createPix(i: CreatePixInput): Promise<CreatedPix> {
    const customer = await this.customer(i.payer);
    const due = new Date(i.expiresAt.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const pay = await readJson(
      await this.req('/payments', {
        method: 'POST',
        body: JSON.stringify({
          customer,
          billingType: 'PIX',
          value: i.amountCents / 100,
          dueDate: due,
          description: i.description.slice(0, 500) || 'Pagamento',
          externalReference: i.externalRef,
        }),
      }),
      'Asaas',
    );
    const qr = await readJson(await this.req(`/payments/${pay.id}/pixQrCode`), 'Asaas');
    if (!qr?.payload) throw new PaymentError('Asaas não devolveu o código Pix. Confira se a conta tem chave Pix cadastrada.');
    return { providerId: String(pay.id), qrCode: qr.payload, ticketUrl: pay.invoiceUrl };
  }

  async getStatus(id: string): Promise<PixStatus> {
    const body = await readJson(await this.req(`/payments/${encodeURIComponent(id)}`), 'Asaas');
    if (body.status === 'RECEIVED' || body.status === 'CONFIRMED' || body.status === 'RECEIVED_IN_CASH') return 'paid';
    if (body.deleted || body.status === 'REFUNDED' || body.status === 'REFUND_REQUESTED') return 'cancelled';
    if (body.status === 'OVERDUE') return 'expired';
    return 'pending';
  }

  async verify(): Promise<string> {
    await readJson(await this.req('/customers?limit=1'), 'Asaas');
    try {
      const info = await readJson(await this.req('/myAccount/commercialInfo'), 'Asaas');
      return String(info.companyName ?? info.name ?? 'conta Asaas');
    } catch {
      return 'conta Asaas';
    }
  }
}

/** Pix de mentira para o simulador: nada sai para provedor nenhum. */
export class SimulatedPix implements PixProvider {
  static paid = new Set<string>();
  async createPix(i: CreatePixInput): Promise<CreatedPix> {
    return { providerId: `sim_${i.externalRef}`, qrCode: `00020126580014BR.GOV.BCB.PIX0136SIMULADO-${i.externalRef.slice(0, 8)}5204000053039865802BR6304ABCD` };
  }
  async getStatus(id: string): Promise<PixStatus> {
    return SimulatedPix.paid.has(id) ? 'paid' : 'pending';
  }
  async verify() {
    return 'simulador';
  }
}
