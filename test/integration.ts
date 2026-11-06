/**
 * Teste de integração com Postgres + Redis reais (sem chamar a Meta).
 * Pré-requisitos: `docker compose up -d`, `.env` configurado, `npm run db:migrate`, `npm run seed`.
 *   npm run test:int
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/api/app.js';
import { config } from '../src/config.js';
import { Engine } from '../src/engine/engine.js';
import { encrypt, hmacSha256Hex } from '../src/lib/crypto.js';
import { closeDb, db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { inboundQueue, scheduledQueue } from '../src/queue/queues.js';
import { PgStore } from '../src/store/pg.js';
import { FakeIg } from './helpers.js';

const sql = db();
const IG = `9${Date.now()}`;

const [ws] = await sql`select id from autoflow.workspaces order by created_at desc limit 1`;
assert.ok(ws, 'Rode npm run seed antes');
const allDay = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [['00:00', '23:59']]]));
await sql`update autoflow.workspaces set settings = settings || ${sql.json({ business_hours: allDay })} where id = ${ws.id}`;
const [acc] = await sql`
  insert into autoflow.ig_accounts (workspace_id, ig_user_id, username) values (${ws.id}, ${IG}, 'pizzaria_teste') returning id`;
await sql`insert into autoflow.ig_account_tokens (ig_account_id, access_token_enc, token_expires_at)
          values (${acc!.id}, ${encrypt('tok', config().ENCRYPTION_KEY)}, now() + interval '60 days')`;

// ── Motor + PgStore ──
const ig = new FakeIg();
const engine = new Engine({
  store: new PgStore(sql),
  ig,
  consumeQuota: async () => true,
  scheduler: { schedule: async () => {} },
});

await engine.handleEvent({ kind: 'comment', igUserId: IG, commentId: `c${Date.now()}`, text: 'eu quero o cardápio', fromId: 'u-int', mediaId: 'm1', timestamp: Date.now() });
assert.equal(ig.publicReplies.length, 1, 'resposta pública');
assert.equal(ig.sent.length, 1, 'DM privada');
const first = ig.sent[0]!.msg;
assert.equal(first.kind, 'buttons');
if (first.kind !== 'buttons' || first.buttons[1]!.type !== 'postback') throw new Error('botões');

// clica em "Fazer pedido"
await engine.handleEvent({ kind: 'postback', igUserId: IG, senderId: 'u-int', mid: `pb${Date.now()}`, payload: first.buttons[1]!.payload, timestamp: Date.now() });
const [contact] = await sql`select * from autoflow.contacts where igsid = 'u-int' and ig_account_id = ${acc!.id}`;
const [sess] = await sql`select * from autoflow.sessions where contact_id = ${contact!.id} order by started_at desc limit 1`;
console.log('  sessão após clique:', sess!.status, sess!.current_node_id, '| última msg:', JSON.stringify(ig.sent.at(-1)!.msg).slice(0, 80));

if (sess!.status === 'waiting_input') {
  await engine.handleEvent({ kind: 'dm', igUserId: IG, senderId: 'u-int', mid: `d1${Date.now()}`, text: 'Ivan', timestamp: Date.now() });
  await engine.handleEvent({ kind: 'dm', igUserId: IG, senderId: 'u-int', mid: `d2${Date.now()}`, text: 'Rua X, 10', timestamp: Date.now() });
  await engine.handleEvent({ kind: 'dm', igUserId: IG, senderId: 'u-int', mid: `d3${Date.now()}`, text: '31988887777', timestamp: Date.now() });
  await engine.handleEvent({ kind: 'dm', igUserId: IG, senderId: 'u-int', mid: `d4${Date.now()}`, text: '2 pizzas', timestamp: Date.now() });
  await engine.handleEvent({ kind: 'dm', igUserId: IG, senderId: 'u-int', mid: `d5${Date.now()}`, text: 'Pix', timestamp: Date.now() });
  const [f] = await sql`select values from autoflow.contact_fields where contact_id = ${contact!.id}`;
  assert.deepEqual(f!.values, { nome: 'Ivan', endereco: 'Rua X, 10', telefone: '31988887777', pedido: '2 pizzas', pagamento: 'Pix' });
  const tags = await sql`select t.name from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id where ct.contact_id = ${contact!.id}`;
  assert.ok(tags.some((t) => t.name === 'pedido-feito'));
  const [order] = await sql`select number, summary, details, status from autoflow.orders where contact_id = ${contact!.id}`;
  assert.equal(order?.summary, '2 pizzas');
  assert.equal(order?.status, 'new');
  assert.equal((order?.details as { label: string }[]).length, 4);
  console.log(`  ✓ fluxo de pedido completo no Postgres (pedido #${order!.number})`);
} else {
  console.log('  (fora do horário do seed — fluxo respondeu "fechado")');
}
const [{ n }] = (await sql`select count(*)::int as n from autoflow.messages where contact_id = ${contact!.id}`) as unknown as [{ n: number }];
assert.ok(n >= 3, 'mensagens registradas');
console.log(`  ✓ ${n} mensagens no log`);

// ── API ──
const panelUser = { id: randomUUID(), email: 'teste@example.com' };
const app = await buildServer({ verifyToken: async (token) => token === 'panel-test-token' ? panelUser : null });
await sql`insert into autoflow.workspace_members (workspace_id, user_id) values (${ws.id}, ${panelUser.id})`;
const verify = await app.inject({ url: `/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${config().IG_WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc` });
assert.equal(verify.body, 'abc');

const body = JSON.stringify({
  object: 'instagram',
  entry: [{ id: IG, time: 1, messaging: [{ sender: { id: 'u-api' }, recipient: { id: IG }, timestamp: 1, message: { mid: `api${Date.now()}`, text: 'cardapio' } }] }],
});
const sig = `sha256=${hmacSha256Hex(config().IG_APP_SECRET, Buffer.from(body))}`;
const bad = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
assert.equal(bad.statusCode, 401);
const ok = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
assert.equal(ok.statusCode, 200);
const dup = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
assert.equal(dup.statusCode, 200);
const waiting = await inboundQueue().getJobCounts('wait', 'delayed');
console.log('  ✓ webhook assinado aceito, inválido recusado; fila inbound:', waiting);

const unauth = await app.inject({ method: 'POST', url: `/admin/workspaces/${ws.id}/connect-link` });
assert.equal(unauth.statusCode, 401);
const link = await app.inject({ method: 'POST', url: `/admin/workspaces/${ws.id}/connect-link`, headers: { 'x-api-key': config().ADMIN_API_KEY } });
const start = await app.inject({ url: new URL(link.json().url).pathname + new URL(link.json().url).search });
assert.equal(start.statusCode, 302);
assert.ok(/^https:\/\/www\.(instagram\.com\/oauth\/authorize|facebook\.com\/v[\d.]+\/dialog\/oauth)/.test(String(start.headers.location)));
console.log('  login URL:', String(start.headers.location).split('&state')[0]);
console.log('  ✓ link de conexão redireciona para o Instagram');

// Retorno do Login Unificado com uma conta atribuída e confirmação do webhook.
if (config().IG_LOGIN_MODE === 'facebook' && config().IG_LOGIN_CONFIG_ID) {
  const panelHeaders = { authorization: 'Bearer panel-test-token', 'x-workspace-id': ws.id };
  const panelLink = await app.inject({ method: 'POST', url: '/app/connect-link', headers: panelHeaders });
  assert.equal(panelLink.statusCode, 200);
  const panelStart = new URL(panelLink.json().url);
  assert.equal(panelStart.origin, new URL(config().IG_CONNECT_START_BASE_URL ?? config().PUBLIC_BASE_URL).origin);
  const beginLogin = () => app.inject({ url: panelStart.pathname + panelStart.search });
  const authorize = new URL(String((await beginLogin()).headers.location));
  assert.equal(authorize.searchParams.get('prompt'), 'login');
  assert.equal(authorize.searchParams.get('config_id'), config().IG_LOGIN_CONFIG_ID);
  const callback = '/auth/instagram/callback?' + new URLSearchParams({
    code: 'test-code',
    state: authorize.searchParams.get('state')!,
  });

  const unifiedId = `${IG}1`;
  const fetchOriginal = globalThis.fetch;
  let subscribed = false;
  let subscriptionAccepted = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'graph.facebook.com');
    if (url.pathname.endsWith('/oauth/access_token')) {
      assert.equal(url.searchParams.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
      assert.equal(url.searchParams.get('code'), 'test-code');
      return Response.json({ access_token: 'system-user-test-token' });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer system-user-test-token');
    if (url.pathname.endsWith('/me/assigned_instagram_accounts')) {
      return Response.json({ data: [{ id: unifiedId, username: 'teste_unificado' }] });
    }
    assert.ok(url.pathname.endsWith(`/${unifiedId}/subscribed_apps`), url.pathname);
    assert.equal(init?.method, 'POST');
    assert.equal(url.searchParams.get('subscribed_fields'), 'messages,messaging_postbacks,comments');
    subscribed = true;
    return Response.json({ success: subscriptionAccepted });
  };
  try {
    const rejected = await app.inject({ url: callback });
    assert.equal(rejected.statusCode, 500);
    assert.match(rejected.body, /inscrição da conta nas notificações/);
    assert.ok(subscribed);
    assert.equal((await sql`select id from autoflow.ig_accounts where ig_user_id = ${unifiedId}`).length, 0);

    const result = await beginLogin();
    const retry = new URL(String(result.headers.location));
    subscriptionAccepted = true;
    const connected = await app.inject({ url: '/auth/instagram/callback?' + new URLSearchParams({
      code: 'test-code',
      state: retry.searchParams.get('state')!,
    }) });
    assert.equal(connected.statusCode, config().DASHBOARD_URL ? 302 : 200);
    assert.match(String(connected.headers.location ?? connected.body), /teste_unificado/);
    const [account] = await sql`
      select a.workspace_id, a.status, t.token_expires_at
      from autoflow.ig_accounts a join autoflow.ig_account_tokens t on t.ig_account_id = a.id
      where a.ig_user_id = ${unifiedId}`;
    assert.equal(account?.workspace_id, ws.id);
    assert.equal(account?.status, 'active');
    assert.equal(account?.token_expires_at, null);
    const accounts = await app.inject({ url: '/app/accounts', headers: panelHeaders });
    assert.equal(accounts.statusCode, 200);
    assert.ok(accounts.json().some((item: { username: string; status: string }) =>
      item.username === 'teste_unificado' && item.status === 'active',
    ));
    console.log('  ✓ Login Unificado: confirma webhook antes de concluir e salva conta no negócio correto');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

// Criar e publicar fluxo via API
const flow = await app.inject({
  method: 'POST',
  url: '/admin/flows',
  headers: { 'x-api-key': config().ADMIN_API_KEY },
  payload: { workspace_id: ws.id, name: 'Teste API', graph: { start: 'a', nodes: { a: { type: 'message', data: { text: 'oi' } } } } },
});
const pub = await app.inject({ method: 'POST', url: `/admin/flows/${flow.json().id}/publish`, headers: { 'x-api-key': config().ADMIN_API_KEY } });
assert.equal(pub.statusCode, 200, pub.body);
const trg = await app.inject({
  method: 'POST',
  url: '/admin/triggers',
  headers: { 'x-api-key': config().ADMIN_API_KEY },
  payload: { workspace_id: ws.id, flow_id: flow.json().id, type: 'dm_keyword', config: { keywords: ['teste'] } },
});
assert.equal(trg.statusCode, 200, trg.body);
const badTrg = await app.inject({
  method: 'POST',
  url: '/admin/triggers',
  headers: { 'x-api-key': config().ADMIN_API_KEY },
  payload: { workspace_id: ws.id, flow_id: flow.json().id, type: 'dm_keyword', config: {} },
});
assert.equal(badTrg.statusCode, 400);
const stats = await app.inject({ url: `/admin/flows/${flow.json().id}/stats`, headers: { 'x-api-key': config().ADMIN_API_KEY } });
assert.equal(stats.statusCode, 200);
console.log('  ✓ admin: criar/publicar fluxo, gatilho validado, stats');

// ── Cupons únicos (API do painel + PgStore) ──
{
  const h = { authorization: 'Bearer panel-test-token', 'x-workspace-id': ws.id };
  const pg = new PgStore(sql);
  const [c1, c2] = await sql`select id from autoflow.contacts where workspace_id = ${ws.id} limit 2`;
  const [ct] = c2 ? [c2] : await sql`
    insert into autoflow.contacts (workspace_id, ig_account_id, igsid) values (${ws.id}, ${acc!.id}, ${'u-cupom-' + Date.now()}) returning id`;
  const gen = await app.inject({ method: 'POST', url: '/app/coupons', headers: h, payload: { name: 'Teste', discount: '10% OFF', prefix: 'teste', valid_days: 7 } });
  assert.equal(gen.statusCode, 200, gen.body);
  const a = await pg.assignCoupon(ws.id, gen.json().id, c1!.id);
  const again = await pg.assignCoupon(ws.id, gen.json().id, c1!.id);
  const b = await pg.assignCoupon(ws.id, gen.json().id, ct!.id);
  assert.ok(a.status === 'new' && /^TESTE-[A-Z2-9]{6}$/.test(a.code) && a.expiresAt, JSON.stringify(a));
  assert.ok(again.status === 'existing' && again.code === a.code);
  assert.ok(b.status === 'new' && b.code !== a.code);

  const list = await app.inject({ method: 'POST', url: '/app/coupons', headers: h, payload: { name: 'Lista', mode: 'list', codes: `L${Date.now()}A\nL${Date.now()}A` } });
  assert.equal(list.json().added, 1);
  assert.equal((await pg.assignCoupon(ws.id, list.json().id, c1!.id)).status, 'new');
  assert.equal((await pg.assignCoupon(ws.id, list.json().id, ct!.id)).status, 'sold_out');

  const look = await app.inject({ url: `/app/coupons/lookup?code=${a.status === 'new' ? a.code.toLowerCase() : ''}`, headers: h });
  assert.equal(look.json().status, 'valid');
  const red = await app.inject({ method: 'POST', url: '/app/coupons/redeem', headers: h, payload: { code: a.status === 'new' ? a.code : '' } });
  assert.equal(red.json().status, 'used');
  const twice = await app.inject({ method: 'POST', url: '/app/coupons/redeem', headers: h, payload: { code: a.status === 'new' ? a.code : '' } });
  assert.equal(twice.statusCode, 409);
  const camps = await app.inject({ url: '/app/coupons', headers: h });
  const row = camps.json().find((x: { id: string }) => x.id === gen.json().id);
  assert.deepEqual([row.given, row.redeemed], [2, 1]);
  console.log('  ✓ cupons: código único por pessoa, lista esgota, baixa no balcão');
}

// ── Automação rápida + link rastreado ──
{
  const h = { authorization: 'Bearer panel-test-token', 'x-workspace-id': ws.id };
  const r = await app.inject({
    method: 'POST',
    url: '/app/automations/comment-dm',
    headers: h,
    payload: {
      target: { kind: 'any' },
      keywords: ['guia, GUIA2'],
      public_replies: ['Te chamei no direct!'],
      followers_only: true,
      message: { text: 'Aqui está 👇', links: [{ label: 'Abrir', url: 'site.com/guia' }] },
      follow_up: { enabled: true, minutes: 30 },
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const { flow_id, trigger_id } = r.json();
  const [f] = await sql`select status from autoflow.flows where id = ${flow_id}`;
  const [t] = await sql`select type, config from autoflow.triggers where id = ${trigger_id}`;
  assert.equal(f!.status, 'published');
  assert.deepEqual([t!.type, t!.config.keywords], ['comment', ['guia', 'GUIA2']]);

  const pg = new PgStore(sql);
  const [ct] = await sql`select id from autoflow.contacts where workspace_id = ${ws.id} limit 1`;
  const code = await pg.createLink({ workspaceId: ws.id, flowId: flow_id, nodeId: 'entrega', contactId: ct!.id, url: 'https://site.com/guia', actions: [{ type: 'add_tag', tag: 'clicou-guia' }] });
  assert.equal(await pg.createLink({ workspaceId: ws.id, flowId: flow_id, nodeId: 'entrega', contactId: ct!.id, url: 'https://site.com/guia' }), code);
  assert.equal(await pg.hasClickedLink(ct!.id, flow_id, new Date(Date.now() - 60_000)), false);
  const go = await app.inject({ url: `/r/${code}` });
  assert.equal(go.statusCode, 302);
  assert.equal(go.headers.location, 'https://site.com/guia');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await pg.hasClickedLink(ct!.id, flow_id, new Date(Date.now() - 60_000)), true);
  assert.ok((await pg.getTags(ct!.id)).includes('clicou-guia'));
  assert.equal((await app.inject({ url: '/r/naoexiste' })).statusCode, 404);
  console.log('  ✓ automação rápida publicada com gatilho; link rastreado conta o clique e roda a ação');
}

await app.close();
await inboundQueue().obliterate({ force: true });
await scheduledQueue().close();
await inboundQueue().close();
await closeDb();
redis().disconnect();
console.log('✓ Integração OK');
