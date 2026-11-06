/**
 * Cupons únicos (/app/coupons): campanhas, códigos entregues e baixa no balcão.
 * A entrega acontece no fluxo, pela ação "Entregar cupom" (cada pessoa recebe um código só dela).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { z } from 'zod';
import { normalizePrefix, parseCodeList } from '../../lib/coupon.js';
import { db } from '../../lib/db.js';
import { HttpError } from '../http.js';

const uuid = z.string().uuid();
const idOf = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
const MAX_LIST = 20_000;

/** Insere a lista de códigos; os que já existem no negócio são ignorados. */
async function insertCodes(tx: postgres.TransactionSql, ws: string, campaignId: string, codes: string[]) {
  if (codes.length > MAX_LIST) throw new HttpError(400, `No máximo ${MAX_LIST.toLocaleString('pt-BR')} códigos por vez`);
  let added = 0;
  for (let i = 0; i < codes.length; i += 1000) {
    const rows = codes.slice(i, i + 1000).map((code) => ({ workspace_id: ws, campaign_id: campaignId, code }));
    const r = await tx`insert into autoflow.coupons ${tx(rows, 'workspace_id', 'campaign_id', 'code')} on conflict do nothing returning id`;
    added += r.length;
  }
  return { added, skipped: codes.length - added };
}

export async function couponRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();

  app.get('/app/coupons', async (req) =>
    sql`
      select c.id, c.name, c.discount, c.mode, c.prefix, c.valid_days, c.archived, c.created_at,
             count(k.id) filter (where k.assigned_at is not null)::int as given,
             count(k.id) filter (where k.redeemed_at is not null)::int as redeemed,
             count(k.id) filter (where k.assigned_at is null)::int as available,
             max(k.assigned_at) as last_given_at
      from autoflow.coupon_campaigns c
      left join autoflow.coupons k on k.campaign_id = c.id
      where c.workspace_id = ${wsOf(req)}
      group by c.id
      order by c.archived, c.created_at desc`,
  );

  app.post('/app/coupons', async (req) => {
    const ws = wsOf(req);
    const b = z
      .object({
        name: z.string().trim().min(1, 'Dê um nome para a campanha').max(80),
        discount: z.string().trim().max(80).default(''),
        mode: z.enum(['generated', 'list']).default('generated'),
        prefix: z.string().max(30).default(''),
        valid_days: z.number().int().min(1).max(365).nullable().default(null),
        codes: z.string().max(1_500_000).default(''),
      })
      .parse(req.body);
    const codes = b.mode === 'list' ? parseCodeList(b.codes) : [];
    if (b.mode === 'list' && !codes.length) throw new HttpError(400, 'Cole os códigos da lista (um por linha)');
    return sql.begin(async (tx) => {
      const [c] = await tx`
        insert into autoflow.coupon_campaigns (workspace_id, name, discount, mode, prefix, valid_days)
        values (${ws}, ${b.name}, ${b.discount}, ${b.mode}, ${normalizePrefix(b.prefix)}, ${b.valid_days})
        returning id, name`;
      const r = codes.length ? await insertCodes(tx, ws, c!.id as string, codes) : { added: 0, skipped: 0 };
      return { ...c, ...r };
    });
  });

  app.patch('/app/coupons/:id', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        discount: z.string().trim().max(80).optional(),
        prefix: z.string().max(30).optional(),
        valid_days: z.number().int().min(1).max(365).nullable().optional(),
        archived: z.boolean().optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined) patch[k] = k === 'prefix' ? normalizePrefix(v as string) : v;
    if (!Object.keys(patch).length) return { ok: true };
    const r = await sql`
      update autoflow.coupon_campaigns set ${sql(patch)} where id = ${idOf(req)} and workspace_id = ${wsOf(req)} returning id`;
    if (!r.length) throw new HttpError(404, 'Campanha não encontrada');
    return { ok: true };
  });

  /** Mais códigos para uma campanha de lista. */
  app.post('/app/coupons/:id/codes', async (req) => {
    const ws = wsOf(req);
    const id = idOf(req);
    const { codes } = z.object({ codes: z.string().max(1_500_000) }).parse(req.body);
    const list = parseCodeList(codes);
    if (!list.length) throw new HttpError(400, 'Cole os códigos (um por linha)');
    return sql.begin(async (tx) => {
      const [c] = await tx`select mode from autoflow.coupon_campaigns where id = ${id} and workspace_id = ${ws}`;
      if (!c) throw new HttpError(404, 'Campanha não encontrada');
      if (c.mode !== 'list') throw new HttpError(400, 'Essa campanha gera os códigos sozinha');
      return insertCodes(tx, ws, id, list);
    });
  });

  /** Códigos já entregues (com quem recebeu e se usou). */
  app.get('/app/coupons/:id/codes', async (req) => {
    const { q } = z.object({ q: z.string().max(80).optional() }).parse(req.query);
    const like = q?.trim() ? `%${q.trim()}%` : null;
    return sql`
      select k.code, k.assigned_at, k.expires_at, k.redeemed_at, k.contact_id, ct.name as contact_name, ct.username as contact_username
      from autoflow.coupons k
      left join autoflow.contacts ct on ct.id = k.contact_id
      where k.campaign_id = ${idOf(req)} and k.workspace_id = ${wsOf(req)} and k.assigned_at is not null
        ${like ? sql`and (k.code ilike ${like} or ct.name ilike ${like} or ct.username ilike ${like})` : sql``}
      order by k.assigned_at desc
      limit 1000`;
  });

  const findCode = async (ws: string, code: string) => {
    const [k] = await sql`
      select k.id, k.code, k.assigned_at, k.expires_at, k.redeemed_at, k.contact_id,
             c.name as campaign_name, c.discount, ct.name as contact_name, ct.username as contact_username
      from autoflow.coupons k
      join autoflow.coupon_campaigns c on c.id = k.campaign_id
      left join autoflow.contacts ct on ct.id = k.contact_id
      where k.workspace_id = ${ws} and upper(k.code) = upper(${code.trim()})
      limit 1`;
    if (!k) throw new HttpError(404, 'Cupom não encontrado. Confira as letras e os números.');
    const status = k.redeemed_at ? 'used' : !k.assigned_at ? 'not_given' : k.expires_at && new Date(k.expires_at as Date) < new Date() ? 'expired' : 'valid';
    return { ...(k as Record<string, any>), status } as Record<string, any> & { id: string; status: string };
  };

  /** Consulta um código digitado no balcão. */
  app.get('/app/coupons/lookup', async (req) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(60) }).parse(req.query);
    return findCode(wsOf(req), code);
  });

  /** Dá baixa (marca como usado) — ou desfaz. */
  app.post('/app/coupons/redeem', async (req) => {
    const ws = wsOf(req);
    const b = z.object({ code: z.string().trim().min(1).max(60), undo: z.boolean().default(false) }).parse(req.body);
    const k = await findCode(ws, b.code);
    if (b.undo) {
      await sql`update autoflow.coupons set redeemed_at = null where id = ${k.id}`;
      return findCode(ws, b.code);
    }
    if (k.status === 'used') throw new HttpError(409, `Este cupom já foi usado em ${new Date(k.redeemed_at as Date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`);
    if (k.status === 'not_given') throw new HttpError(409, 'Este código ainda não foi entregue a ninguém.');
    if (k.status === 'expired') throw new HttpError(409, 'Este cupom está vencido.');
    await sql`update autoflow.coupons set redeemed_at = now() where id = ${k.id} and redeemed_at is null`;
    return findCode(ws, b.code);
  });
}
