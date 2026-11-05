/**
 * Diagnóstico do token da Meta: descobre o tipo, as permissões e por qual API ele funciona.
 *   npx tsx scripts/diagnose-token.ts SEU_TOKEN
 * Usa IG_APP_ID e IG_APP_SECRET do .env. Não imprime o token nem a chave.
 */
import 'dotenv/config';

const token = process.argv[2];
const appId = process.env.IG_APP_ID;
const secret = process.env.IG_APP_SECRET;
const V = process.env.IG_GRAPH_VERSION ?? 'v21.0';
if (!token || !appId || !secret) {
  console.error('Uso: npx tsx scripts/diagnose-token.ts SEU_TOKEN  (IG_APP_ID e IG_APP_SECRET precisam estar no .env)');
  process.exit(1);
}

async function get(label: string, url: string) {
  try {
    const res = await fetch(url);
    const body = await res.json();
    console.log(`\n── ${label} (HTTP ${res.status})`);
    console.log(JSON.stringify(body, null, 2).replaceAll(token!, '<token>').replaceAll(secret!, '<secret>'));
    return body as any;
  } catch (err) {
    console.log(`\n── ${label}: falhou`, (err as Error).message);
    return null;
  }
}

const enc = encodeURIComponent;
await get('1. debug_token (tipo, app, permissões, validade)', `https://graph.facebook.com/${V}/debug_token?input_token=${enc(token)}&access_token=${enc(`${appId}|${secret}`)}`);
await get('2. /me no Facebook Graph', `https://graph.facebook.com/${V}/me?fields=id,name&access_token=${enc(token)}`);
const pages = await get(
  '3. Páginas e Instagram ligados',
  `https://graph.facebook.com/${V}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${enc(token)}`,
);
await get('4. /me no Instagram Graph', `https://graph.instagram.com/${V}/me?fields=user_id,username,account_type&access_token=${enc(token)}`);
await get('5. Conta IG 17841421611254301 via Facebook Graph', `https://graph.facebook.com/${V}/17841421611254301?fields=id,username,name&access_token=${enc(token)}`);
await get('6. Apps inscritos nos webhooks (Instagram Graph)', `https://graph.instagram.com/${V}/me/subscribed_apps?access_token=${enc(token)}`);
if (pages?.data?.[0]?.id) {
  await get('7. Apps inscritos na Página', `https://graph.facebook.com/${V}/${pages.data[0].id}/subscribed_apps?access_token=${enc(token)}`);
}
console.log('\n✓ Diagnóstico concluído — copie tudo acima e mande para o Claude.');
