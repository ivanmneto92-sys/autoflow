/**
 * Cria um workspace de exemplo com o template de restaurante publicado e os gatilhos,
 * e imprime o link "Conectar Instagram".
 *
 *   npm run seed -- "Pizzaria do Zé"
 */
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { validateGraph } from '../src/flow/schema.js';
import { parseTriggerConfig } from '../src/flow/triggers.js';
import { signState } from '../src/lib/crypto.js';
import { closeDb, db } from '../src/lib/db.js';

type Template = {
  name: string;
  flow: unknown;
  triggers: { type: 'comment' | 'dm_keyword' | 'story_mention' | 'postback' | 'default_reply'; priority: number; config: unknown }[];
};

const name = process.argv[2] ?? 'Restaurante Demo';
const tpl = JSON.parse(readFileSync('templates/restaurante.json', 'utf8')) as Template;
const { graph, issues } = validateGraph(tpl.flow);
if (!graph || issues.some((i) => i.level === 'error')) {
  console.error('Template inválido:', issues);
  process.exit(1);
}
for (const w of issues) console.warn('⚠', w.node ?? '', w.message);

const sql = db();
const result = await sql.begin(async (tx) => {
  const [ws] = await tx`
    insert into autoflow.workspaces (name, settings) values (${name}, ${tx.json({
      timezone: 'America/Sao_Paulo',
      bot_pause_hours: 12,
      business_hours: {
        tue: [['18:00', '23:00']],
        wed: [['18:00', '23:00']],
        thu: [['18:00', '23:00']],
        fri: [['18:00', '23:59']],
        sat: [['18:00', '23:59']],
        sun: [['18:00', '23:00']],
      },
    })}) returning id`;
  const [flow] = await tx`
    insert into autoflow.flows (workspace_id, name, draft_graph, status)
    values (${ws!.id}, ${tpl.name}, ${tx.json(graph as any)}, 'published') returning id`;
  const [v] = await tx`
    insert into autoflow.flow_versions (flow_id, version, graph) values (${flow!.id}, 1, ${tx.json(graph as any)}) returning id`;
  await tx`update autoflow.flows set published_version_id = ${v!.id} where id = ${flow!.id}`;
  for (const t of tpl.triggers) {
    await tx`
      insert into autoflow.triggers (workspace_id, flow_id, type, config, priority)
      values (${ws!.id}, ${flow!.id}, ${t.type}, ${tx.json(parseTriggerConfig(t.type, t.config) as any)}, ${t.priority})`;
  }
  return { workspaceId: ws!.id as string, flowId: flow!.id as string };
});

const s = signState({ workspaceId: result.workspaceId }, config().STATE_SECRET, 7 * 24 * 3600);
console.log(`
✓ Workspace criado: ${name}
  workspace_id: ${result.workspaceId}
  flow_id:      ${result.flowId}

👉 Link para conectar o Instagram (válido 7 dias):
  ${config().PUBLIC_BASE_URL}/auth/instagram/start?s=${s}
`);
await closeDb();
