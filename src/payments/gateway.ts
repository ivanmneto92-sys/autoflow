/**
 * Ponte entre o motor de fluxos e os provedores de Pix: cria a cobrança, guarda em autoflow.payments,
 * atualiza o pedido ligado e consulta o status.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { Asaas, MercadoPago, PaymentError, SimulatedPix, type PixProvider, type PixStatus, type ProviderName } from './providers.js';

export interface CreateChargeInput {
  workspaceId: string;
  provider?: ProviderName;
  simulator: boolean;
  amountCents: number;
  description: string;
  expiresAt: Date;
  contact: { id: string; name?: string | null; email?: string | null; cpf?: string | null };
  sessionId: string;
  orderId?: string | null;
}

export interface PaymentGateway {
  create(i: CreateChargeInput): Promise<{ paymentId: string; qrCode: string; ticketUrl?: string }>;
  /** Consulta o provedor e atualiza a cobrança (e o pedido). Devolve o status atual. */
  refresh(paymentId: string): Promise<PixStatus>;
}

type ProviderFactory = (provider: ProviderName, token: string, sandbox: boolean) => PixProvider;

const defaultFactory: ProviderFactory = (p, token, sandbox) => (p === 'mercadopago' ? new MercadoPago(token) : new Asaas(token, sandbox));

export class PgPaymentGateway implements PaymentGateway {
  constructor(
    private sql: postgres.Sql,
    private factory: ProviderFactory = defaultFactory,
  ) {}

  /** Provedor configurado do negócio: o pedido no nó → o padrão das Configurações → o único conectado. */
  async providerFor(workspaceId: string, wanted?: ProviderName): Promise<{ name: ProviderName; client: PixProvider }> {
    const rows = await this.sql`
      select a.provider, a.token_enc, a.sandbox, w.settings->>'payment_provider' as preferred
      from autoflow.payment_accounts a join autoflow.workspaces w on w.id = a.workspace_id
      where a.workspace_id = ${workspaceId}`;
    if (!rows.length) throw new PaymentError('Nenhuma conta de Pix conectada. Conecte o Mercado Pago ou o Asaas em Configurações.');
    const pick =
      rows.find((r) => r.provider === wanted) ??
      (wanted ? undefined : (rows.find((r) => r.provider === rows[0]!.preferred) ?? rows[0]));
    if (!pick) throw new PaymentError(`A conta ${wanted === 'asaas' ? 'Asaas' : 'Mercado Pago'} não está conectada.`);
    const name = pick.provider as ProviderName;
    return { name, client: this.factory(name, decrypt(pick.token_enc as string, config().ENCRYPTION_KEY), Boolean(pick.sandbox)) };
  }

  async create(i: CreateChargeInput) {
    const id = randomUUID();
    const { name, client } = i.simulator ? { name: 'simulador', client: new SimulatedPix() } : await this.providerFor(i.workspaceId, i.provider);
    const created = await client.createPix({
      amountCents: i.amountCents,
      description: i.description,
      externalRef: id,
      expiresAt: i.expiresAt,
      payer: i.contact,
      notificationUrl: name === 'mercadopago' ? `${config().PUBLIC_BASE_URL}/webhooks/mercadopago/${i.workspaceId}` : undefined,
    });
    await this.sql`
      insert into autoflow.payments (id, workspace_id, contact_id, session_id, order_id, provider, provider_id, amount_cents,
                                     description, qr_code, ticket_url, expires_at)
      values (${id}, ${i.workspaceId}, ${i.contact.id}, ${i.sessionId}, ${i.orderId ?? null}, ${name}, ${created.providerId},
              ${i.amountCents}, ${i.description}, ${created.qrCode}, ${created.ticketUrl ?? null}, ${i.expiresAt})`;
    if (i.orderId)
      await this.sql`
        update autoflow.orders set payment_status = 'pending', total_cents = coalesce(total_cents, ${i.amountCents}),
          payment = ${this.sql.json({ payment_id: id, provider: name })}, updated_at = now()
        where id = ${i.orderId} and workspace_id = ${i.workspaceId}`;
    return { paymentId: id, qrCode: created.qrCode, ticketUrl: created.ticketUrl };
  }

  async refresh(paymentId: string): Promise<PixStatus> {
    const [p] = await this.sql`select * from autoflow.payments where id = ${paymentId}`;
    if (!p) return 'cancelled';
    if (p.status !== 'pending') return p.status as PixStatus;

    let status: PixStatus = 'pending';
    if (p.provider !== 'simulador') {
      const { client } = await this.providerFor(p.workspace_id as string, p.provider as ProviderName);
      status = await client.getStatus(p.provider_id as string);
    }
    // Venceu sem pagar (com 2 min de folga para o banco confirmar)
    if (status === 'pending' && new Date(p.expires_at as Date).getTime() < Date.now() - 120_000) status = 'expired';
    if (status === 'pending') return status;
    await this.mark(paymentId, status);
    return status;
  }

  /** Grava o novo status (e reflete no pedido). Só muda cobranças ainda pendentes. */
  async mark(paymentId: string, status: Exclude<PixStatus, 'pending'>): Promise<boolean> {
    const [p] = await this.sql`
      update autoflow.payments set status = ${status}, paid_at = ${status === 'paid' ? this.sql`now()` : null}, updated_at = now()
      where id = ${paymentId} and status = 'pending'
      returning order_id, workspace_id`;
    if (!p) return false;
    if (p.order_id)
      await this.sql`
        update autoflow.orders set payment_status = ${status === 'paid' ? 'paid' : 'expired'}, updated_at = now()
        where id = ${p.order_id}`;
    return true;
  }
}
