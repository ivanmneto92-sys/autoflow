/**
 * Conecta uma conta usando um token gerado no painel da Meta (sem passar pelo link de OAuth).
 *   npx tsx scripts/connect-token.ts SEU_TOKEN [ig_id] [workspace_id]
 * ig_id: ID da conta do Instagram (use com token de "usuário do sistema", que não lista Páginas).
 * Sem workspace_id, usa o workspace criado por último.
 */
import { config } from '../src/config.js';
import { connectFacebookUser, saveAccount } from '../src/instagram/connect.js';
import { GraphIgClient } from '../src/instagram/client.js';
import { closeDb, db } from '../src/lib/db.js';

const token = process.argv[2];
if (!token) {
  console.error('Uso: npx tsx scripts/connect-token.ts SEU_TOKEN [workspace_id]');
  process.exit(1);
}
const sql = db();
const igIdArg = process.argv[3];
let workspaceId = process.argv[4];
if (!workspaceId) {
  const [ws] = await sql`select id, name from autoflow.workspaces order by created_at desc limit 1`;
  if (!ws) throw new Error('Nenhum workspace. Rode npm run seed antes.');
  workspaceId = ws.id as string;
  console.log(`• Workspace: ${ws.name} (${workspaceId})`);
}

try {
  if (token.startsWith('IG')) {
    // Token do login do Instagram (IGAA…), ex.: gerado no painel da Meta ou usado em outro sistema
    const ig = new GraphIgClient();
    const me = await ig.getMe(token);
    await saveAccount(
      sql,
      workspaceId,
      { igUserId: String(me.user_id), username: me.username, name: me.name, profilePictureUrl: me.profile_picture_url, accountType: me.account_type },
      token,
      60 * 24 * 3600,
    );
    try {
      await ig.subscribeWebhooks(token);
      console.log('• Webhooks inscritos (mensagens, cliques e comentários)');
    } catch (err) {
      console.warn('⚠ Não consegui inscrever os webhooks:', (err as Error).message);
    }
    console.log(`✓ Conectado: @${me.username} (ID ${me.user_id})`);
  } else if (config().IG_LOGIN_MODE === 'facebook' && igIdArg) {
    // Token de usuário do sistema: acessa a conta IG direto pelo ID (precisa estar atribuída ao usuário do sistema)
    const ig = new GraphIgClient();
    const acc = await ig.getIgAccount(token, igIdArg);
    await saveAccount(
      sql,
      workspaceId,
      { igUserId: acc.id, username: acc.username, name: acc.name, profilePictureUrl: acc.profile_picture_url, accountType: 'BUSINESS' },
      token,
      null,
    );
    console.log(`✓ Conectado: @${acc.username}`);
  } else if (config().IG_LOGIN_MODE === 'facebook') {
    const users = await connectFacebookUser(sql, workspaceId, token);
    console.log(`✓ Conectado: ${users.map((u) => '@' + u).join(', ')}`);
  } else {
    const ig = new GraphIgClient();
    const me = await ig.getMe(token);
    await saveAccount(
      sql,
      workspaceId,
      { igUserId: String(me.user_id), username: me.username, name: me.name, profilePictureUrl: me.profile_picture_url, accountType: me.account_type },
      token,
      60 * 24 * 3600,
    );
    await ig.subscribeWebhooks(token);
    console.log(`✓ Conectado: @${me.username}`);
  }
  console.log('  Agora mande "oi" para essa conta a partir de OUTRA conta do Instagram.');
} catch (err) {
  console.error('✗ Falhou:', (err as Error).message);
  console.error('  Rode: npx tsx scripts/diagnose-token.ts SEU_TOKEN  e mande a saída para o Claude.');
  process.exitCode = 1;
} finally {
  await closeDb();
}
