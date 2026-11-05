/**
 * OAuth da "Instagram API com login do Instagram".
 * Fluxo: authorize → code → token curto → token longo (~60 dias) → refresh periódico.
 */
import { config } from '../config.js';

export function instagramConnectUrl(state: string): string {
  const c = config();
  const url = new URL('/auth/instagram/start', c.IG_CONNECT_START_BASE_URL ?? c.PUBLIC_BASE_URL);
  url.searchParams.set('s', state);
  return url.toString();
}

export function redirectUri(): string {
  return `${config().PUBLIC_BASE_URL}/auth/instagram/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const c = config();
  if (c.IG_LOGIN_MODE === 'facebook') {
    // Login unificado / Login do Facebook para Empresas: as permissões vêm do config_id
    // Doc oficial (Facebook Login for Business, configuração de usuário do sistema):
    // config_id no lugar de scope, response_type=code e override_default_response_type=true
    const url = new URL(`https://www.facebook.com/${c.IG_GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set('client_id', c.IG_APP_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('override_default_response_type', 'true');
    if (c.IG_LOGIN_CONFIG_ID) {
      url.searchParams.set('config_id', c.IG_LOGIN_CONFIG_ID);
      url.searchParams.set('prompt', 'login');
    } else
      url.searchParams.set(
        'scope',
        'instagram_basic,instagram_manage_messages,instagram_manage_comments,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_metadata,business_management',
      );
    return url.toString();
  }
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', c.IG_APP_ID);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', c.IG_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('enable_fb_login', '0');
  url.searchParams.set('force_authentication', '1');
  return url.toString();
}

async function parse<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error || body.error_message) {
    const msg = (body.error as { message?: string })?.message ?? body.error_message ?? res.statusText;
    throw new Error(`${what} falhou (${res.status}): ${String(msg)}`);
  }
  return body as T;
}

/** Troca o `code` pelo token de curta duração. */
export async function exchangeCode(code: string): Promise<{ accessToken: string; userId: string }> {
  const c = config();
  const form = new URLSearchParams({
    client_id: c.IG_APP_ID,
    client_secret: c.IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    // O Instagram às vezes devolve o code com "#_" no final
    code: code.replace(/#_$/, ''),
  });
  const res = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  type R = { access_token?: string; user_id?: string | number; data?: { access_token: string; user_id: string | number }[] };
  const body = await parse<R>(res, 'Troca do code');
  const item = body.data?.[0] ?? body;
  if (!item.access_token) throw new Error('Resposta sem access_token');
  return { accessToken: item.access_token, userId: String(item.user_id) };
}

/** Token curto → token longo (~60 dias). */
export async function exchangeLongLived(shortToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL('https://graph.instagram.com/access_token');
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', config().IG_APP_SECRET);
  url.searchParams.set('access_token', shortToken);
  const body = await parse<{ access_token: string; expires_in: number }>(await fetch(url), 'Token longo');
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

/** Renova o token longo (precisa ter pelo menos 24h e não estar expirado). */
export async function refreshLongLived(token: string): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  const body = await parse<{ access_token: string; expires_in: number }>(await fetch(url), 'Refresh do token');
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

// ───────────── Modo facebook (login unificado) ─────────────

const fbBase = () => `https://graph.facebook.com/${config().IG_GRAPH_VERSION}`;

/** Troca o código pelo token emitido pela configuração de login. */
export async function fbExchangeCode(code: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  const c = config();
  const url = new URL(`${fbBase()}/oauth/access_token`);
  url.searchParams.set('client_id', c.IG_APP_ID);
  url.searchParams.set('client_secret', c.IG_APP_SECRET);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code', code);
  const body = await parse<{ access_token?: string; expires_in?: number }>(
    await fetch(url, { signal: AbortSignal.timeout(10_000) }), 'Troca do code (Facebook)',
  );
  if (!body.access_token) throw new Error('Resposta sem access_token');
  return { accessToken: body.access_token, expiresIn: body.expires_in && body.expires_in > 0 ? body.expires_in : null };
}

/** token curto → token longo (~60 dias). Tokens de Página gerados a partir dele não expiram. */
export async function fbExchangeLongLived(token: string): Promise<string> {
  const c = config();
  const url = new URL(`${fbBase()}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', c.IG_APP_ID);
  url.searchParams.set('client_secret', c.IG_APP_SECRET);
  url.searchParams.set('fb_exchange_token', token);
  try {
    const body = await parse<{ access_token: string }>(await fetch(url), 'Token longo (Facebook)');
    return body.access_token;
  } catch {
    return token; // tokens de sistema/painel já podem ser longos
  }
}

export interface FbLinkedAccount {
  pageId: string;
  pageName: string;
  pageToken: string;
  igUserId: string;
  username: string;
  name?: string;
  profilePictureUrl?: string;
}

/** Lista as Páginas do usuário que têm uma conta do Instagram profissional ligada. */
export async function fbListInstagramAccounts(userToken: string): Promise<FbLinkedAccount[]> {
  const url = new URL(`${fbBase()}/me/accounts`);
  url.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}');
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', userToken);
  type Page = {
    id: string;
    name: string;
    access_token: string;
    instagram_business_account?: { id: string; username: string; name?: string; profile_picture_url?: string };
  };
  const body = await parse<{ data: Page[] }>(await fetch(url), 'Listar Páginas');
  return body.data
    .filter((p) => p.instagram_business_account)
    .map((p) => ({
      pageId: p.id,
      pageName: p.name,
      pageToken: p.access_token,
      igUserId: p.instagram_business_account!.id,
      username: p.instagram_business_account!.username,
      name: p.instagram_business_account!.name,
      profilePictureUrl: p.instagram_business_account!.profile_picture_url,
    }));
}

/** Inscreve o app nos webhooks da Página (necessário para receber DMs do Instagram ligado a ela). */
export async function fbSubscribePage(pageId: string, pageToken: string): Promise<void> {
  const url = new URL(`${fbBase()}/${pageId}/subscribed_apps`);
  url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks,feed');
  url.searchParams.set('access_token', pageToken);
  await parse(await fetch(url, { method: 'POST' }), 'Inscrever Página nos webhooks');
}

/** Resumo do token (tipo e permissões) — usado no diagnóstico de erro. */
export async function fbDebugToken(token: string): Promise<{
  type?: string;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
}> {
  const c = config();
  const dbg = new URL(`${fbBase()}/debug_token`);
  dbg.searchParams.set('input_token', token);
  dbg.searchParams.set('access_token', `${c.IG_APP_ID}|${c.IG_APP_SECRET}`);
  const body = await parse<{ data: any }>(await fetch(dbg), 'Ler permissões do token');
  return body.data ?? {};
}

interface AssignedInstagramAccount {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

/** Lista só os perfis atribuídos ao token do Login Unificado. */
export async function fbListAssignedInstagramAccounts(token: string): Promise<AssignedInstagramAccount[]> {
  const url = new URL(`${fbBase()}/me/assigned_instagram_accounts`);
  url.searchParams.set('fields', 'id,username,name,profile_picture_url');
  url.searchParams.set('limit', '100');
  const accounts = new Map<string, AssignedInstagramAccount>();
  const cursors = new Set<string>();

  while (true) {
    const page = await parse<{
      data: AssignedInstagramAccount[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }), 'Listar contas atribuídas');
    for (const account of page.data) {
      if (/^\d+$/.test(account.id) && account.username) accounts.set(account.id, account);
    }
    if (!page.paging?.next) return [...accounts.values()];
    const after = page.paging.cursors?.after;
    if (!after || cursors.has(after)) throw new Error('Paginação inválida das contas atribuídas');
    cursors.add(after);
    url.searchParams.set('after', after);
  }
}

type IgFound = { igUserId: string; username: string; name?: string; profilePictureUrl?: string; pageId?: string; pageToken?: string };

/**
 * Contas IG autorizadas no token (login unificado / usuário do sistema):
 * olha os target_ids de todas as permissões — IDs de conta IG ou de Página com IG ligado.
 */
/** Detalhes da última busca (aparece na tela de erro para diagnóstico). */
export let lastDiag: Record<string, unknown> = {};

export async function fbIgAccountsFromToken(token: string): Promise<IgFound[]> {
  lastDiag = {};
  const info = await fbDebugToken(token);
  const ids = new Set<string>();
  for (const g of info.granular_scopes ?? []) for (const id of g.target_ids ?? []) ids.add(id);

  const out = new Map<string, IgFound>();
  for (const id of ids) {
    // 1) O ID é uma conta do Instagram?
    try {
      const url = new URL(`${fbBase()}/${id}`);
      url.searchParams.set('fields', 'id,username,name,profile_picture_url');
      url.searchParams.set('access_token', token);
      const a = await parse<{ id: string; username?: string; name?: string; profile_picture_url?: string }>(await fetch(url), 'Conta IG');
      if (a.username) {
        out.set(a.id, { igUserId: a.id, username: a.username, name: a.name, profilePictureUrl: a.profile_picture_url });
        continue;
      }
    } catch {
      /* não é conta IG */
    }
    // 2) O ID é uma Página com Instagram ligado?
    try {
      const url = new URL(`${fbBase()}/${id}`);
      url.searchParams.set('fields', 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}');
      url.searchParams.set('access_token', token);
      const p = await parse<{ id: string; access_token?: string; instagram_business_account?: { id: string; username: string; name?: string; profile_picture_url?: string } }>(
        await fetch(url),
        'Página',
      );
      const ig = p.instagram_business_account;
      if (ig)
        out.set(ig.id, {
          igUserId: ig.id,
          username: ig.username,
          name: ig.name,
          profilePictureUrl: ig.profile_picture_url,
          pageId: p.id,
          pageToken: p.access_token,
        });
    } catch {
      /* ignora */
    }
  }
  // 4) Páginas atribuídas e portfólios do token
  const tryList = async (path: string, fields: string) => {
    try {
      const url = new URL(`${fbBase()}${path}`);
      url.searchParams.set('fields', fields);
      url.searchParams.set('limit', '100');
      url.searchParams.set('access_token', token);
      return (await parse<{ data: any[] }>(await fetch(url), path)).data ?? [];
    } catch (err) {
      lastDiag[path] = (err as Error).message.slice(0, 120);
      return [];
    }
  };
  // 3) Token de usuário do sistema da integração: contas do Instagram designadas pelo cliente no login
  if (!out.size) {
    const list = await tryList('/me/assigned_instagram_accounts', 'id,username,name,profile_picture_url');
    lastDiag.assigned_instagram_accounts = list.length;
    for (const ig of list) if (ig.username) out.set(ig.id, { igUserId: ig.id, username: ig.username, name: ig.name, profilePictureUrl: ig.profile_picture_url });
  }
  if (!out.size) {
    for (const p of await tryList('/me/assigned_pages', 'id,access_token,instagram_business_account{id,username,name,profile_picture_url}')) {
      const ig = p.instagram_business_account;
      if (ig) out.set(ig.id, { igUserId: ig.id, username: ig.username, name: ig.name, profilePictureUrl: ig.profile_picture_url, pageId: p.id, pageToken: p.access_token });
    }
  }
  // Token de "usuário do sistema da integração" (login unificado / Facebook para Empresas):
  // o portfólio do cliente vem em me?fields=client_business_id
  if (!out.size) {
    try {
      const url = new URL(`${fbBase()}/me`);
      url.searchParams.set('fields', 'id,name,client_business_id');
      url.searchParams.set('access_token', token);
      const me = await parse<{ id: string; client_business_id?: string }>(await fetch(url), 'me');
      lastDiag.me = me;
      if (me.client_business_id) {
        for (const edge of ['owned_instagram_accounts', 'instagram_business_accounts', 'instagram_accounts', 'client_instagram_accounts']) {
          const list = await tryList(`/${me.client_business_id}/${edge}`, 'id,username,name,profile_picture_url');
          lastDiag[edge] = list.length;
          for (const ig of list) if (ig.username) out.set(ig.id, { igUserId: ig.id, username: ig.username, name: ig.name, profilePictureUrl: ig.profile_picture_url });
        }
        for (const p of await tryList(`/${me.client_business_id}/owned_pages`, 'id,access_token,instagram_business_account{id,username,name,profile_picture_url}')) {
          const ig = p.instagram_business_account;
          if (ig) out.set(ig.id, { igUserId: ig.id, username: ig.username, name: ig.name, profilePictureUrl: ig.profile_picture_url, pageId: p.id, pageToken: p.access_token });
        }
      }
    } catch (err) {
      lastDiag.meError = (err as Error).message;
    }
  }
  if (!out.size) {
    for (const b of await tryList('/me/businesses', 'id')) {
      for (const edge of ['owned_instagram_accounts', 'instagram_accounts', 'client_instagram_accounts']) {
        for (const ig of await tryList(`/${b.id}/${edge}`, 'id,username,name,profile_picture_url')) {
          if (ig.username) out.set(ig.id, { igUserId: ig.id, username: ig.username, name: ig.name, profilePictureUrl: ig.profile_picture_url });
        }
      }
    }
  }
  return [...out.values()];
}
