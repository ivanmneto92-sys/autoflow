import type postgres from 'postgres';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { refreshLongLived } from '../instagram/oauth.js';
import { decrypt, encrypt } from '../lib/crypto.js';

/** Renova tokens que expiram nos próximos 10 dias. */
export async function refreshExpiringTokens(sql: postgres.Sql, log: Logger): Promise<void> {
  const key = config().ENCRYPTION_KEY;
  const rows = await sql`
    select t.ig_account_id, t.access_token_enc, a.username
    from autoflow.ig_account_tokens t join autoflow.ig_accounts a on a.id = t.ig_account_id
    where a.status = 'active' and t.token_expires_at < now() + interval '10 days'`;

  for (const row of rows) {
    try {
      const fresh = await refreshLongLived(decrypt(row.access_token_enc, key));
      await sql`
        update autoflow.ig_account_tokens set
          access_token_enc = ${encrypt(fresh.accessToken, key)},
          token_expires_at = now() + make_interval(secs => ${fresh.expiresIn}),
          refreshed_at = now()
        where ig_account_id = ${row.ig_account_id}`;
      log.info({ account: row.username }, 'Token renovado');
    } catch (err) {
      log.error({ err, account: row.username }, 'Falha ao renovar token');
      await sql`update autoflow.ig_accounts set status = 'token_expired', updated_at = now() where id = ${row.ig_account_id}`;
    }
  }
}
