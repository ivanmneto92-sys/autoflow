/**
 * Salva contas conectadas (usado pelo callback do OAuth e pelo script connect-token).
 */
import type postgres from 'postgres';
import { config } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { GraphIgClient } from './client.js';
import { exchangeLongLived, fbDebugToken, lastDiag, fbExchangeLongLived, fbIgAccountsFromToken, fbListInstagramAccounts, fbSubscribePage } from './oauth.js';

interface AccountData {
  igUserId: string;
  username: string;
  name?: string | null;
  profilePictureUrl?: string | null;
  accountType?: string | null;
  pageId?: string | null;
}

export async function saveAccount(
  sql: postgres.Sql,
  workspaceId: string,
  a: AccountData,
  token: string,
  expiresInSec: number | null,
): Promise<string> {
  const [acc] = await sql`
    insert into autoflow.ig_accounts (workspace_id, ig_user_id, username, name, profile_picture_url, account_type, page_id, status)
    values (${workspaceId}, ${a.igUserId}, ${a.username}, ${a.name ?? null}, ${a.profilePictureUrl ?? null},
            ${a.accountType ?? null}, ${a.pageId ?? null}, 'active')
    on conflict (ig_user_id) do update set
      workspace_id = excluded.workspace_id, username = excluded.username, name = excluded.name,
      profile_picture_url = excluded.profile_picture_url, account_type = excluded.account_type,
      page_id = excluded.page_id, status = 'active', updated_at = now()
    returning id`;
  const expires = expiresInSec ? sql`now() + make_interval(secs => ${expiresInSec})` : sql`null`;
  await sql`
    insert into autoflow.ig_account_tokens (ig_account_id, access_token_enc, token_expires_at)
    values (${acc!.id}, ${encrypt(token, config().ENCRYPTION_KEY)}, ${expires})
    on conflict (ig_account_id) do update set
      access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at, refreshed_at = now()`;
  return acc!.id as string;
}

/**
 * Modo facebook (login unificado): token de usuário → Páginas com Instagram → salva cada conta com o token da Página.
 * Retorna os @ conectados.
 */
export async function connectFacebookUser(sql: postgres.Sql, workspaceId: string, userToken: string): Promise<string[]> {
  const longToken = await fbExchangeLongLived(userToken);
  const accounts = await fbListInstagramAccounts(longToken).catch(() => []);
  if (!accounts.length) {
    // Login unificado com "Continuar com o Instagram": não há Página. As contas autorizadas
    // vêm nos granular_scopes do token (target_ids).
    const direct = await fbIgAccountsFromToken(longToken);
    if (direct.length) {
      const done: string[] = [];
      for (const a of direct) {
        const viaPage = Boolean(a.pageId && a.pageToken);
        await saveAccount(
          sql,
          workspaceId,
          { igUserId: a.igUserId, username: a.username, name: a.name, profilePictureUrl: a.profilePictureUrl, accountType: 'BUSINESS', pageId: viaPage ? a.pageId : null },
          viaPage ? a.pageToken! : longToken,
          viaPage ? null : 60 * 24 * 3600,
        );
        if (viaPage) await fbSubscribePage(a.pageId!, a.pageToken!).catch(() => {});
        done.push(a.username);
      }
      return done;
    }
    // Nada encontrado: mostra o que o token tem, para diagnóstico
    const info = await fbDebugToken(longToken).catch(() => ({}) as Awaited<ReturnType<typeof fbDebugToken>>);
    const scopes = (info.granular_scopes ?? []).map((g) => `${g.scope}${g.target_ids?.length ? `[${g.target_ids.join(',')}]` : '[]'}`).join(' ');
    await sql`
      insert into autoflow.pending_connections (workspace_id, token_enc, diag)
      values (${workspaceId}, ${encrypt(longToken, config().ENCRYPTION_KEY)}, ${sql.json({ type: info.type, scopes, lastDiag } as any)})`.catch(() => {});
    throw new Error(
      `Nenhuma conta do Instagram autorizada foi encontrada neste login. Token: ${info.type ?? '?'} · permissões: ${scopes || (info.scopes ?? []).join(' ') || 'nenhuma'} · detalhes: ${JSON.stringify(lastDiag)}`,
    );
  }
  const done: string[] = [];
  for (const a of accounts) {
    await saveAccount(
      sql,
      workspaceId,
      { igUserId: a.igUserId, username: a.username, name: a.name, profilePictureUrl: a.profilePictureUrl, pageId: a.pageId, accountType: 'BUSINESS' },
      a.pageToken,
      null, // token de Página derivado de token longo não expira
    );
    try {
      await fbSubscribePage(a.pageId, a.pageToken);
    } catch (err) {
      console.warn(`Aviso: não consegui inscrever a Página ${a.pageName} nos webhooks:`, (err as Error).message);
    }
    done.push(a.username);
  }
  return done;
}

/** Modo instagram: token curto do Instagram → token longo → salva. */
export async function connectInstagramUser(
  sql: postgres.Sql,
  workspaceId: string,
  shortToken: string,
  fallbackUserId?: string,
): Promise<string[]> {
  const ig = new GraphIgClient();
  const long = await exchangeLongLived(shortToken);
  const me = await ig.getMe(long.accessToken);
  await saveAccount(
    sql,
    workspaceId,
    {
      igUserId: String(me.user_id ?? fallbackUserId),
      username: me.username,
      name: me.name,
      profilePictureUrl: me.profile_picture_url,
      accountType: me.account_type,
    },
    long.accessToken,
    long.expiresIn,
  );
  await ig.subscribeWebhooks(long.accessToken);
  return [me.username];
}
