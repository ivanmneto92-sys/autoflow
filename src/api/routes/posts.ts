/**
 * Publicações agendadas (/app/posts) e upload de mídia (/app/media).
 * Registrado dentro de appRoutes: já passa pelo login do painel e pela checagem do workspace.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { fbDebugToken } from '../../instagram/oauth.js';
import { db } from '../../lib/db.js';
import { MEDIA_TYPES_ALLOWED, PDF_MAX_MB, mediaRoot, mediaUrl, ownMediaFile } from '../../posts/media.js';
import { AutomationSchema, checkPostRules, PostInputSchema, type PostInput } from '../../posts/schema.js';
import { PgStore } from '../../store/pg.js';
import { HttpError } from '../http.js';

const uuid = z.string().uuid();
const idOf = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
const MAX_AHEAD_DAYS = 180;
/** Tamanho máximo de cada pedaço do envio em partes (o Cloudflare barra acima de 100 MB por requisição). */
export const CHUNK_MAX_MB = 60;

/** Apaga envios em partes abandonados há mais de 1 dia. */
async function cleanupStaleParts(dir: string) {
  const files = await readdir(dir).catch(() => [] as string[]);
  const old = Date.now() - 86_400_000;
  for (const f of files.filter((x) => x.endsWith('.part'))) {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && s.mtimeMs < old) await unlink(p).catch(() => {});
  }
}

export async function postRoutes(app: FastifyInstance, wsOf: (req: FastifyRequest) => string) {
  const sql = db();
  const store = new PgStore(sql);

  // Corpo bruto (stream) para os tipos de mídia — o arquivo vai direto para o disco
  app.addContentTypeParser(Object.keys(MEDIA_TYPES_ALLOWED), (_req, payload, done) => done(null, payload));

  app.post('/app/media', async (req) => {
    const ws = wsOf(req);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const allowed = MEDIA_TYPES_ALLOWED[type];
    if (!allowed) throw new HttpError(415, 'Formato não aceito. Use imagem JPG, vídeo MP4/MOV ou PDF.');
    const maxMb = allowed.kind === 'file' ? Math.min(PDF_MAX_MB, config().MEDIA_MAX_MB) : config().MEDIA_MAX_MB;
    const max = maxMb * 1024 * 1024;
    if (Number(req.headers['content-length'] ?? 0) > max) throw new HttpError(413, `Arquivo maior que ${maxMb} MB`);

    const dir = join(mediaRoot(), ws);
    await mkdir(dir, { recursive: true });
    const file = `${randomUUID()}.${allowed.ext}`;
    const path = join(dir, file);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new HttpError(413, `Arquivo maior que ${maxMb} MB`));
        cb(null, chunk);
      },
    });
    const source = req.body as NodeJS.ReadableStream;
    source.on('error', () => {}); // o pipeline trata; evita derrubar a API se o cliente cair no meio
    try {
      await pipeline(source, limit, createWriteStream(path, { flags: 'wx' }));
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err instanceof HttpError ? err : new HttpError(400, 'O envio do arquivo foi interrompido. Tente de novo.');
    }
    if (!size) {
      await unlink(path).catch(() => {});
      throw new HttpError(400, 'Arquivo vazio');
    }
    return { url: mediaUrl(ws, file), kind: allowed.kind, size };
  });

  /**
   * Envio em partes (vídeos grandes): o Cloudflare barra requisições acima de 100 MB, então o painel manda
   * pedaços de até CHUNK_MAX_MB, em ordem. Cabeçalhos: x-upload-id (UUID do envio), x-offset (byte inicial
   * do pedaço) e x-total (tamanho do arquivo inteiro). Reenviar um pedaço é seguro (corta e regrava a partir do offset).
   * Quando chega o último byte, o arquivo é renomeado e a resposta traz a URL, igual ao /app/media.
   */
  app.post('/app/media/chunk', async (req) => {
    const ws = wsOf(req);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const allowed = MEDIA_TYPES_ALLOWED[type];
    if (!allowed) throw new HttpError(415, 'Formato não aceito. Use imagem JPG, vídeo MP4/MOV ou PDF.');
    const id = String(req.headers['x-upload-id'] ?? '').toLowerCase();
    const offset = Number(req.headers['x-offset']);
    const total = Number(req.headers['x-total']);
    if (!uuid.safeParse(id).success || !Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || total <= 0 || offset >= total)
      throw new HttpError(400, 'Envio inválido. Tente de novo.');
    const max = config().MEDIA_MAX_MB * 1024 * 1024;
    if (total > max) throw new HttpError(413, `Arquivo maior que ${config().MEDIA_MAX_MB} MB`);

    const dir = join(mediaRoot(), ws);
    await mkdir(dir, { recursive: true });
    const final = join(dir, `${id}.${allowed.ext}`);
    const part = `${final}.part`;
    if (offset === 0) await cleanupStaleParts(dir);
    else {
      const have = await stat(part).then((s) => s.size).catch(() => -1);
      if (have < offset) throw new HttpError(409, 'O envio se perdeu no meio. Escolha o arquivo de novo.');
    }
    // Começa do zero no 1º pedaço; nos demais, corta o que passou do offset (pedaço reenviado)
    if (offset === 0) await writeFile(part, '');
    else await truncate(part, offset);

    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > CHUNK_MAX_MB * 1024 * 1024 || offset + size > total) return cb(new HttpError(413, 'Pedaço maior que o esperado'));
        cb(null, chunk);
      },
    });
    const source = req.body as NodeJS.ReadableStream;
    source.on('error', () => {});
    try {
      await pipeline(source, limit, createWriteStream(part, { flags: 'a' }));
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(400, 'O envio foi interrompido. Tente de novo.');
    }
    if (!size) throw new HttpError(400, 'Pedaço vazio');
    const received = offset + size;
    if (received < total) return { received };
    await rename(part, final);
    return { url: mediaUrl(ws, `${id}.${allowed.ext}`), kind: allowed.kind, size: total };
  });

  /** A conta deu permissão para publicar? (null = não dá para saber com esse tipo de token) */
  app.get('/app/accounts/:id/publish-permission', async (req) => {
    const id = idOf(req);
    const [acc] = await sql`select id from autoflow.ig_accounts where id = ${id} and workspace_id = ${wsOf(req)}`;
    if (!acc) throw new HttpError(404, 'Conta não encontrada');
    const token = await store.getAccessToken(id);
    if (token.startsWith('IG')) return { can_publish: null };
    try {
      const info = await fbDebugToken(token);
      const scopes = info.scopes ?? [];
      return { can_publish: scopes.includes('instagram_content_publish') };
    } catch {
      return { can_publish: null };
    }
  });

  app.get('/app/posts', async (req) => {
    return sql`
      select p.id, p.ig_account_id, p.media_type, p.media, p.caption, p.scheduled_at, p.status, p.automation,
             p.trigger_id, p.ig_media_id, p.permalink, p.error, p.created_at, p.published_at,
             a.username, a.profile_picture_url, f.name as flow_name, f.status as flow_status,
             -- Resultados do post: quantas pessoas a automação atendeu e quantas clicaram num link do fluxo
             (select count(*)::int from autoflow.trigger_fires tf where tf.trigger_id = p.trigger_id) as people,
             (select count(distinct l.contact_id)::int from autoflow.links l
                join autoflow.trigger_fires tf on tf.contact_id = l.contact_id and tf.trigger_id = p.trigger_id
               where l.flow_id = (p.automation->>'flow_id')::uuid and l.first_clicked_at is not null) as clicked,
             -- Seguidores ganhos pela automação: não seguia e passou a seguir depois de falar com ela
             (select count(distinct e.contact_id)::int from autoflow.events e
                join autoflow.trigger_fires tf on tf.contact_id = e.contact_id and tf.trigger_id = p.trigger_id
               where e.flow_id = (p.automation->>'flow_id')::uuid and e.type = 'follow_checked' and (e.data->>'gained')::boolean) as gained
      from autoflow.scheduled_posts p
      join autoflow.ig_accounts a on a.id = p.ig_account_id
      left join autoflow.flows f on f.id = (p.automation->>'flow_id')::uuid
      where p.workspace_id = ${wsOf(req)}
      order by p.scheduled_at desc
      limit 300`;
  });

  /**
   * Funil da publicação: do comentário até o pedido. Conta pessoas (não eventos), sempre entre as que a
   * automação deste post atendeu, para que cada etapa seja um pedaço da anterior.
   */
  app.get('/app/posts/:id/funnel', async (req) => {
    const id = idOf(req);
    const [p] = await sql`
      select id, ig_media_id, trigger_id, (automation->>'flow_id')::uuid as flow_id, status, published_at
      from autoflow.scheduled_posts where id = ${id} and workspace_id = ${wsOf(req)}`;
    if (!p) throw new HttpError(404, 'Publicação não encontrada');
    const ws = wsOf(req);
    const [r] = await sql`
      with fired as (
        select contact_id from autoflow.trigger_fires where trigger_id = ${p.trigger_id}
      ), ev as (
        select e.contact_id, e.type, e.data from autoflow.events e
        where e.flow_id = ${p.flow_id} and e.contact_id in (select contact_id from fired)
      )
      select
        (select count(*)::int from autoflow.messages m
          where m.workspace_id = ${ws} and m.source = 'comment' and m.payload->>'media_id' = ${p.ig_media_id ?? ''}) as comments,
        (select count(distinct m.contact_id)::int from autoflow.messages m
          where m.workspace_id = ${ws} and m.source = 'comment' and m.payload->>'media_id' = ${p.ig_media_id ?? ''}) as commenters,
        (select count(*)::int from fired) as served,
        (select count(distinct contact_id)::int from ev where type in ('button_clicked', 'gate_clicked')) as tapped,
        (select count(distinct contact_id)::int from ev where type = 'follow_checked' and not (data->>'follows')::boolean) as not_following,
        (select count(distinct contact_id)::int from ev where type = 'follow_checked' and (data->>'gained')::boolean) as gained,
        (select count(distinct l.contact_id)::int from autoflow.links l
          where l.flow_id = ${p.flow_id} and l.first_clicked_at is not null and l.contact_id in (select contact_id from fired)) as clicked,
        (select count(*)::int from autoflow.contact_fields cf
          where cf.contact_id in (select contact_id from fired) and coalesce(cf.values->>'email', '') <> '') as emails,
        (select count(*)::int from autoflow.orders o
          where o.flow_id = ${p.flow_id} and o.contact_id in (select contact_id from fired) and o.status <> 'cancelled') as orders,
        (select coalesce(sum(o.total_cents), 0)::int from autoflow.orders o
          where o.flow_id = ${p.flow_id} and o.contact_id in (select contact_id from fired) and o.payment_status = 'paid') as paid_cents`;
    return { post_id: p.id, has_automation: Boolean(p.flow_id), published: p.status === 'published', ...r };
  });

  /** Valida tudo o que dá antes de salvar. */
  async function validate(ws: string, input: PostInput) {
    const rule = checkPostRules(input);
    if (rule) throw new HttpError(400, rule);

    const [acc] = await sql`
      select status, account_type from autoflow.ig_accounts where id = ${input.ig_account_id} and workspace_id = ${ws}`;
    if (!acc || acc.account_type === 'SIMULATOR') throw new HttpError(404, 'Conta do Instagram não encontrada');
    if (acc.status !== 'active') throw new HttpError(400, 'Essa conta está desconectada. Reconecte na página Instagram.');

    for (const m of input.media)
      if (!ownMediaFile(m.url, ws)) throw new HttpError(400, 'Arquivo não encontrado. Envie a mídia de novo.');

    if (input.scheduled_at) {
      const when = new Date(input.scheduled_at).getTime();
      if (when < Date.now() - 60_000) throw new HttpError(400, 'Escolha uma data e hora no futuro');
      if (when > Date.now() + MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(400, `Agende no máximo ${MAX_AHEAD_DAYS} dias à frente`);
    }

    if (input.automation) {
      const [flow] = await sql`
        select status from autoflow.flows where id = ${input.automation.flow_id} and workspace_id = ${ws} and status <> 'archived'`;
      if (!flow) throw new HttpError(400, 'Fluxo não encontrado');
    }
  }

  app.post('/app/posts', async (req) => {
    const ws = wsOf(req);
    const input = PostInputSchema.parse(req.body);
    await validate(ws, input);
    const [p] = await sql`
      insert into autoflow.scheduled_posts
        (workspace_id, ig_account_id, media_type, media, caption, scheduled_at, automation, created_by)
      values (${ws}, ${input.ig_account_id}, ${input.media_type}, ${sql.json(input.media)}, ${input.caption},
              ${input.scheduled_at ?? sql`now()`}, ${input.automation ? sql.json(input.automation) : null}, ${req.user!.id})
      returning *`;
    return p;
  });

  /** Só edita o que ainda não saiu (agendado, com erro ou cancelado). Volta para "agendado". */
  app.put('/app/posts/:id', async (req) => {
    const ws = wsOf(req);
    const id = idOf(req);
    const input = PostInputSchema.parse(req.body);
    await validate(ws, input);
    const [p] = await sql`
      update autoflow.scheduled_posts set
        ig_account_id = ${input.ig_account_id}, media_type = ${input.media_type}, media = ${sql.json(input.media)},
        caption = ${input.caption}, scheduled_at = ${input.scheduled_at ?? sql`now()`},
        automation = ${input.automation ? sql.json(input.automation) : null},
        status = 'scheduled', error = null, ig_container_id = null, attempts = 0, updated_at = now()
      where id = ${id} and workspace_id = ${ws} and status in ('scheduled', 'failed', 'cancelled')
      returning *`;
    if (!p) throw new HttpError(409, 'Essa publicação não pode mais ser editada');
    return p;
  });

  /**
   * Liga/desliga só a automação de um post que ainda não saiu (usado pelo editor de fluxo e por Gatilhos).
   * Depois de publicado, a automação vira um gatilho normal e é editada em Gatilhos.
   */
  app.put('/app/posts/:id/automation', async (req) => {
    const ws = wsOf(req);
    const id = idOf(req);
    const { automation } = z.object({ automation: AutomationSchema.nullable() }).parse(req.body);
    if (automation) {
      const [flow] = await sql`
        select 1 from autoflow.flows where id = ${automation.flow_id} and workspace_id = ${ws} and status <> 'archived'`;
      if (!flow) throw new HttpError(400, 'Fluxo não encontrado');
    }
    const [p] = await sql`
      update autoflow.scheduled_posts set automation = ${automation ? sql.json(automation) : null}, updated_at = now()
      where id = ${id} and workspace_id = ${ws} and status in ('scheduled', 'failed', 'cancelled')
      returning id, automation`;
    if (!p) throw new HttpError(409, 'Essa publicação já saiu: edite a automação dela em Gatilhos');
    return p;
  });

  app.post('/app/posts/:id/publish-now', async (req) => {
    const [p] = await sql`
      update autoflow.scheduled_posts set scheduled_at = now(), status = 'scheduled', error = null,
        ig_container_id = null, attempts = 0, updated_at = now()
      where id = ${idOf(req)} and workspace_id = ${wsOf(req)} and status in ('scheduled', 'failed', 'cancelled')
      returning id`;
    if (!p) throw new HttpError(409, 'Essa publicação não pode ser publicada agora');
    return { ok: true };
  });

  app.post('/app/posts/:id/cancel', async (req) => {
    const [p] = await sql`
      update autoflow.scheduled_posts set status = 'cancelled', updated_at = now()
      where id = ${idOf(req)} and workspace_id = ${wsOf(req)} and status = 'scheduled'
      returning id`;
    if (!p) throw new HttpError(409, 'Só dá para cancelar publicações agendadas');
    return { ok: true };
  });

  /** Remove do painel. Não apaga nada do Instagram; o gatilho criado continua em Gatilhos. */
  app.delete('/app/posts/:id', async (req) => {
    const [p] = await sql`
      delete from autoflow.scheduled_posts
      where id = ${idOf(req)} and workspace_id = ${wsOf(req)} and status <> 'publishing'
      returning id`;
    if (!p) throw new HttpError(409, 'Aguarde terminar de publicar para remover');
    return { ok: true };
  });
}
