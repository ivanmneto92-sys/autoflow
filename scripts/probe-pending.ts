/**
 * Testa, com o token do último login que falhou, todos os caminhos da Graph API para achar a conta do Instagram.
 *   npx tsx scripts/probe-pending.ts                 → só testa e mostra os resultados
 *   npx tsx scripts/probe-pending.ts 17841400000000  → testa e, se a conta responder, conecta com esse ID
 * Não imprime o token.
 */
import { config } from '../src/config.js';
import { saveAccount } from '../src/instagram/connect.js';
import { decrypt } from '../src/lib/crypto.js';
import { closeDb, db } from '../src/lib/db.js';

const sql = db();
const [row] = await sql`select * from autoflow.pending_connections order by created_at desc limit 1`;
if (!row) {
  console.log('Nenhum login pendente. Tente conectar pelo painel primeiro.');
  process.exit(0);
}
const token = decrypt(row.token_enc, config().ENCRYPTION_KEY);
const V = config().IG_GRAPH_VERSION;
const FB = `https://graph.facebook.com/${V}`;
const igArg = process.argv[2];
console.log(`• Login pendente de ${row.created_at.toISOString()} (workspace ${row.workspace_id})`);

async function get(label: string, url: string) {
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  const res = await fetch(u);
  const body = await res.json().catch(() => ({}));
  console.log(`\n── ${label}  [HTTP ${res.status}]`);
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));
  return { ok: res.ok, body: body as any };
}

const dbg = new URL(`${FB}/debug_token`);
dbg.searchParams.set('input_token', token);
dbg.searchParams.set('access_token', `${config().IG_APP_ID}|${config().IG_APP_SECRET}`);
console.log('\n── debug_token');
console.log(JSON.stringify(await (await fetch(dbg)).json(), null, 2));

const me = await get('me (id, name, client_business_id)', `${FB}/me?fields=id,name,client_business_id`);
await get('me/assigned_instagram_accounts', `${FB}/me/assigned_instagram_accounts?fields=id,username,name`);
await get('me/accounts (Páginas)', `${FB}/me/accounts?fields=id,name,instagram_business_account{id,username}`);
await get('me/assigned_pages', `${FB}/me/assigned_pages?fields=id,name,instagram_business_account{id,username}`);
const biz = me.body?.client_business_id;
if (biz) {
  for (const edge of ['owned_instagram_accounts', 'instagram_accounts', 'instagram_business_accounts', 'client_instagram_accounts', 'owned_pages']) {
    await get(`${biz}/${edge}`, `${FB}/${biz}/${edge}?fields=id,username,name`);
  }
}
const ids = [igArg, '17841421611254301'].filter(Boolean) as string[];
for (const id of ids) {
  await get(`conta ${id}`, `${FB}/${id}?fields=id,username,name,profile_picture_url`);
  await get(`conta ${id} conversas`, `${FB}/${id}/conversations?platform=instagram`);
}

if (igArg) {
  const r = await get(`conectar ${igArg}`, `${FB}/${igArg}?fields=id,username,name,profile_picture_url`);
  if (r.ok && r.body.username) {
    await saveAccount(sql, row.workspace_id, { igUserId: r.body.id, username: r.body.username, name: r.body.name, profilePictureUrl: r.body.profile_picture_url, accountType: 'BUSINESS' }, token, null);
    console.log(`\n✓ Conectado: @${r.body.username}`);
  } else console.log('\n✗ A conta não respondeu com esse token.');
}
console.log('\n✓ Fim. Copie tudo acima e mande para o Claude.');
await closeDb();
