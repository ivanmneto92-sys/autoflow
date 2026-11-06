/** Contas de Pix do negócio (/app/payments/*): conectar, testar e desconectar. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { encrypt } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';
import { Asaas, MercadoPago, PaymentError } from '../../payments/providers.js';
import { HttpError } from '../http.js';

const Provider = z.enum(['mercadopago', 'asaas']);

export async function paymentRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();

  app.get('/app/payments/accounts', async (req) => {
    const ws = wsOf(req);
    const rows = await sql`
      select provider, sandbox, account_name, webhook_token, updated_at from autoflow.payment_accounts where workspace_id = ${ws}`;
    const [w] = await sql`select settings->>'payment_provider' as preferred from autoflow.workspaces where id = ${ws}`;
    return {
      preferred: w?.preferred ?? null,
      accounts: rows.map((r) => ({
        provider: r.provider,
        sandbox: r.sandbox,
        account_name: r.account_name,
        updated_at: r.updated_at,
        webhook_url: `${config().PUBLIC_BASE_URL}/webhooks/${r.provider}/${ws}`,
        // Só o Asaas pede um token no cadastro do webhook
        webhook_token: r.provider === 'asaas' ? r.webhook_token : undefined,
      })),
    };
  });

  app.put('/app/payments/accounts/:provider', async (req) => {
    const ws = wsOf(req);
    const provider = Provider.parse((req.params as { provider: string }).provider);
    const body = z.object({ token: z.string().trim().min(10).max(500), sandbox: z.boolean().default(false) }).parse(req.body);
    const client = provider === 'mercadopago' ? new MercadoPago(body.token) : new Asaas(body.token, body.sandbox);
    let name: string;
    try {
      name = await client.verify();
    } catch (err) {
      throw new HttpError(400, err instanceof PaymentError ? err.message : `Não consegui validar a chave: ${(err as Error).message}`);
    }
    const [r] = await sql`
      insert into autoflow.payment_accounts (workspace_id, provider, token_enc, sandbox, webhook_token, account_name)
      values (${ws}, ${provider}, ${encrypt(body.token, config().ENCRYPTION_KEY)}, ${body.sandbox}, ${randomBytes(18).toString('hex')}, ${name})
      on conflict (workspace_id, provider) do update set
        token_enc = excluded.token_enc, sandbox = excluded.sandbox, account_name = excluded.account_name, updated_at = now()
      returning provider, account_name`;
    // Primeira conta conectada vira a padrão
    await sql`
      update autoflow.workspaces set settings = settings || ${sql.json({ payment_provider: provider })}
      where id = ${ws} and coalesce(settings->>'payment_provider', '') = ''`;
    return r;
  });

  app.delete('/app/payments/accounts/:provider', async (req) => {
    const ws = wsOf(req);
    const provider = Provider.parse((req.params as { provider: string }).provider);
    await sql`delete from autoflow.payment_accounts where workspace_id = ${ws} and provider = ${provider}`;
    await sql`
      update autoflow.workspaces set settings = settings - 'payment_provider'
      where id = ${ws} and settings->>'payment_provider' = ${provider}`;
    return { ok: true };
  });

  app.put('/app/payments/preferred', async (req) => {
    const ws = wsOf(req);
    const { provider } = z.object({ provider: Provider }).parse(req.body);
    await sql`update autoflow.workspaces set settings = settings || ${sql.json({ payment_provider: provider })} where id = ${ws}`;
    return { ok: true };
  });
}
