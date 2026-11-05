import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { connectFacebookUser, connectInstagramUser } from '../../instagram/connect.js';
import { buildAuthorizeUrl, exchangeCode, fbExchangeCode } from '../../instagram/oauth.js';
import { safeEqual, signState, verifyState } from '../../lib/crypto.js';
import { db } from '../../lib/db.js';

const page = (title: string, body: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center;color:#222}
h1{font-size:1.4rem}p{color:#555;line-height:1.5}</style></head><body><h1>${title}</h1>${body}</body></html>`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** signed_request da Meta (desautorização / exclusão de dados) */
function parseSignedRequest(signed: string, secret: string): { user_id?: string } | null {
  const [sig, payload] = signed.split('.');
  if (!sig || !payload) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export async function authRoutes(app: FastifyInstance) {

  /** Link de conexão (gerado em /admin/workspaces/:id/connect-link) → tela do Instagram */
  app.get('/auth/instagram/start', async (req, reply) => {
    const { s } = req.query as { s?: string };
    const data = s ? verifyState<{ workspaceId: string }>(s, config().STATE_SECRET) : null;
    if (!data) return reply.code(400).type('text/html').send(page('Link expirado', '<p>Peça um novo link de conexão.</p>'));
    const state = signState({ workspaceId: data.workspaceId }, config().STATE_SECRET, 900);
    return reply.redirect(buildAuthorizeUrl(state));
  });

  app.get('/auth/instagram/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) {
      return reply
        .type('text/html')
        .send(page('Conexão cancelada', `<p>${esc(q.error_description ?? 'Você não autorizou o acesso.')}</p>`));
    }
    const st = q.state ? verifyState<{ workspaceId: string }>(q.state, config().STATE_SECRET) : null;
    if (!q.code || !st) return reply.code(400).type('text/html').send(page('Link inválido', '<p>Tente conectar novamente.</p>'));

    try {
      const sql = db();
      const usernames =
        config().IG_LOGIN_MODE === 'facebook'
          ? await connectFacebookUser(sql, st.workspaceId, await fbExchangeCode(q.code))
          : await (async () => {
              const short = await exchangeCode(q.code!);
              return connectInstagramUser(sql, st.workspaceId, short.accessToken, short.userId);
            })();
      req.log.info({ usernames, workspaceId: st.workspaceId }, 'Instagram conectado');

      const list = usernames.map((u) => `@${esc(u)}`).join(', ');
      const dash = config().DASHBOARD_URL;
      if (dash) return reply.redirect(`${dash}?connected=${encodeURIComponent(usernames.join(','))}`);
      return reply
        .type('text/html')
        .send(page('Instagram conectado ✅', `<p><b>${list}</b> já está pronta para as automações. Pode fechar esta página.</p>`));
    } catch (err) {
      req.log.error({ err }, 'Falha no callback do OAuth');
      return reply
        .code(500)
        .type('text/html')
        .send(
          page(
            'Não foi possível conectar',
            `<p>Confira se a conta é <b>Profissional</b> (Comercial ou Criador de conteúdo)${
              config().IG_LOGIN_MODE === 'facebook' ? ' e se ela foi <b>selecionada</b> na tela da Meta' : ''
            } e tente de novo.</p><p style="font-size:.85rem;color:#888">${esc((err as Error).message ?? '')}</p>${
              config().DASHBOARD_URL ? `<p><a href="${config().DASHBOARD_URL}">← Voltar ao painel</a></p>` : ''
            }`,
          ),
        );
    }
  });

  // ── Callbacks exigidos pela Meta ──
  app.post('/auth/instagram/deauthorize', async (req, reply) => {
    const { signed_request } = req.body as { signed_request?: string };
    const data = signed_request ? parseSignedRequest(signed_request, config().IG_APP_SECRET) : null;
    if (!data?.user_id) return reply.code(400).send({ error: 'invalid signed_request' });
    await db()`update autoflow.ig_accounts set status = 'disconnected', updated_at = now() where ig_user_id = ${String(data.user_id)}`;
    return { ok: true };
  });

  app.post('/auth/instagram/data-deletion', async (req, reply) => {
    const { signed_request } = req.body as { signed_request?: string };
    const data = signed_request ? parseSignedRequest(signed_request, config().IG_APP_SECRET) : null;
    if (!data?.user_id) return reply.code(400).send({ error: 'invalid signed_request' });
    // Remove a conta e tudo ligado a ela (contatos, sessões, mensagens via cascade)
    await db()`delete from autoflow.ig_accounts where ig_user_id = ${String(data.user_id)}`;
    const code = randomBytes(8).toString('hex');
    return { url: `${config().PUBLIC_BASE_URL}/data-deletion?code=${code}`, confirmation_code: code };
  });

  app.get('/data-deletion', async (req, reply) => {
    const { code } = req.query as { code?: string };
    return reply
      .type('text/html')
      .send(page('Exclusão de dados', `<p>Solicitação <b>${(code ?? '').replace(/[^a-f0-9]/g, '')}</b> processada. Seus dados foram removidos.</p>`));
  });
}
