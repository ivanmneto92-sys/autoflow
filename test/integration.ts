/**
 * Teste de integração com Postgres + Redis reais (sem chamar a Meta).
 * Pré-requisitos: `docker compose up -d`, `.env` configurado, `npm run db:migrate`, `npm run seed`.
 *   npm run test:int
 */
import assert from 'node:assert/strict';
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
  const [f] = await sql`select values from autoflow.contact_fields where contact_id = ${contact!.id}`;
  assert.deepEqual(f!.values, { nome: 'Ivan', endereco: 'Rua X, 10', telefone: '31988887777' });
  const tags = await sql`select t.name from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id where ct.contact_id = ${contact!.id}`;
  assert.ok(tags.some((t) => t.name === 'pedido-iniciado'));
  console.log('  ✓ fluxo de pedido completo no Postgres');
} else {
  console.log('  (fora do horário do seed — fluxo respondeu "fechado")');
}
const [{ n }] = (await sql`select count(*)::int as n from autoflow.messages where contact_id = ${contact!.id}`) as unknown as [{ n: number }];
assert.ok(n >= 3, 'mensagens registradas');
console.log(`  ✓ ${n} mensagens no log`);

// ── API ──
const app = await buildServer();
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

await app.close();
await inboundQueue().obliterate({ force: true });
await scheduledQueue().close();
await inboundQueue().close();
await closeDb();
redis().disconnect();
console.log('✓ Integração OK');
