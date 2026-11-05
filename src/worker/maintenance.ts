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
      const token = decrypt(row.access_token_enc, key);
      if (!token.startsWith('IG')) {
        // Tokens de sistema/Página usam a Graph API do Facebook e não admitem ig_refresh_token.
        await sql`
          update autoflow.ig_accounts a set status = 'token_expired', updated_at = now()
          from autoflow.ig_account_tokens t
          where a.id = ${row.ig_account_id} and a.status = 'active' and t.ig_account_id = a.id
            and t.access_token_enc = ${row.access_token_enc} and t.token_expires_at <= now()`;
        continue;
      }
      const fresh = await refreshLongLived(token);
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
