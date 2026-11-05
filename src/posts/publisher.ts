/**
 * Publicador das publicações agendadas (roda dentro do worker).
 * A cada intervalo pega os posts vencidos, cria o contêiner na Meta, espera ficar pronto, publica
 * e, se houver automação, cria o gatilho de comentário só para aquele post.
 */
import type { Logger } from 'pino';
import { IgApiError } from '../instagram/client.js';
import type { Automation, MediaItem, MediaType } from './schema.js';

export interface DuePost {
  id: string;
  workspace_id: string;
  ig_account_id: string;
  media_type: MediaType;
  media: MediaItem[];
  caption: string;
  automation: Automation | null;
  ig_container_id: string | null;
}

export interface PublishClient {
  createMediaContainer(token: string, igUserId: string, params: Record<string, string>): Promise<{ id: string }>;
  getContainerStatus(token: string, containerId: string): Promise<{ status_code?: string; status?: string }>;
  publishMedia(token: string, igUserId: string, creationId: string): Promise<{ id: string }>;
  getMediaInfo(token: string, mediaId: string): Promise<{ id: string; permalink?: string }>;
}

/** Acesso ao banco usado pelo publicador (separado para dar para testar sem Postgres). */
export interface PostRepo {
  claimDue(limit: number): Promise<DuePost[]>;
  /**
   * Posts presos em "publishing" (worker caiu no meio) voltam para a fila mantendo o contêiner —
   * um contêiner só publica uma vez, então retomar não duplica o post. Depois de várias tentativas, viram "failed".
   */
  requeueStuck(): Promise<number>;
  getAccount(accountId: string): Promise<{ igUserId: string; status: string } | null>;
  getToken(accountId: string): Promise<string>;
  markAccountExpired(accountId: string): Promise<void>;
  setContainer(postId: string, containerId: string | null): Promise<void>;
  heartbeat(postId: string): Promise<void>;
  markPublished(postId: string, mediaId: string): Promise<void>;
  setPermalink(postId: string, permalink: string): Promise<void>;
  createCommentTrigger(post: DuePost, mediaId: string): Promise<string>;
  setTrigger(postId: string, triggerId: string | null, warning: string | null): Promise<void>;
  markFailed(postId: string, error: string): Promise<void>;
}

export interface PublisherDeps {
  repo: PostRepo;
  ig: PublishClient;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Quanto esperar o contêiner ficar pronto (Reels demora mais). */
  readyTimeoutMs?: { IMAGE: number; REELS: number };
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class PublishError extends Error {}

/** Mensagem clara para o painel a partir do erro da Meta. */
export function friendlyPublishError(err: unknown): string {
  if (err instanceof PublishError) return err.message;
  if (err instanceof IgApiError) {
    if (err.isAuthError) return 'A conexão com o Instagram expirou. Reconecte a conta na página Instagram.';
    if (err.code === 10 || err.code === 200 || err.code === 3)
      return 'A conta não deu permissão para publicar. Reconecte a conta e aceite a permissão de publicar conteúdo.';
    if (err.subcode === 2207042) return 'O Instagram limitou o número de publicações por hoje nesta conta. Tente de novo mais tarde.';
    if (err.isRateLimit) return 'A Meta pediu para esperar (limite de chamadas). Tente de novo em alguns minutos.';
    return `A Meta recusou a publicação: ${err.message}`;
  }
  return `Falha ao publicar: ${(err as Error)?.message ?? String(err)}`;
}

function containerParams(post: DuePost): Record<string, string> {
  const item = post.media[0];
  if (!item) throw new PublishError('Publicação sem mídia');
  if (post.media_type === 'IMAGE') return { image_url: item.url, caption: post.caption };
  return { media_type: 'REELS', video_url: item.url, caption: post.caption, share_to_feed: 'true' };
}

/** Espera o contêiner ficar pronto. Devolve 'expired' se a Meta descartou (precisa recriar). */
async function waitReady(deps: PublisherDeps, token: string, post: DuePost, containerId: string): Promise<'ready' | 'expired'> {
  const sleep = deps.sleep ?? defaultSleep;
  const timeouts = deps.readyTimeoutMs ?? { IMAGE: 3 * 60_000, REELS: 15 * 60_000 };
  const poll = deps.pollMs ?? 5000;
  const deadline = Date.now() + timeouts[post.media_type];
  for (;;) {
    const st = await deps.ig.getContainerStatus(token, containerId);
    const code = st.status_code ?? 'FINISHED'; // contêiner de imagem às vezes não informa status
    if (code === 'FINISHED') return 'ready';
    if (code === 'EXPIRED') return 'expired';
    if (code === 'PUBLISHED')
      throw new PublishError('O envio foi interrompido, mas a Meta indica que o post já saiu. Confira no Instagram antes de publicar de novo.');
    if (code === 'ERROR')
      throw new PublishError(
        `A Meta não conseguiu processar a mídia${st.status ? ` (${st.status})` : ''}. Confira o formato: ${
          post.media_type === 'REELS' ? 'vídeo MP4/MOV (H.264), de 3 s a 15 min, 9:16' : 'imagem JPG, proporção entre 4:5 e 1,91:1'
        }.`,
      );
    if (Date.now() > deadline) throw new PublishError('A Meta demorou demais para processar a mídia. Tente publicar de novo.');
    await deps.repo.heartbeat(post.id);
    await sleep(poll);
  }
}

/** "Media ID is not available" (9007): a mídia ainda está processando — tenta de novo. */
const notReady = (err: unknown) => err instanceof IgApiError && (err.code === 9007 || err.subcode === 2207027);

export async function publishPost(deps: PublisherDeps, post: DuePost): Promise<'published' | 'failed'> {
  const { repo, ig, log } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  try {
    const account = await repo.getAccount(post.ig_account_id);
    if (!account || account.status !== 'active')
      throw new PublishError('A conta do Instagram não está conectada. Reconecte na página Instagram e publique de novo.');
    const token = await repo.getToken(post.ig_account_id);

    let containerId = post.ig_container_id;
    for (let round = 0; ; round++) {
      if (!containerId) {
        containerId = (await ig.createMediaContainer(token, account.igUserId, containerParams(post))).id;
        await repo.setContainer(post.id, containerId);
      }
      if ((await waitReady(deps, token, post, containerId)) === 'ready') break;
      if (round >= 1) throw new PublishError('A Meta descartou a mídia antes de publicar. Tente de novo.');
      containerId = null; // expirou: cria outro
      await repo.setContainer(post.id, null);
    }

    let mediaId: string | undefined;
    for (let i = 0; !mediaId; i++) {
      try {
        mediaId = (await ig.publishMedia(token, account.igUserId, containerId)).id;
      } catch (err) {
        if (!notReady(err) || i >= 5) throw err;
        await repo.heartbeat(post.id);
        await sleep(deps.pollMs ?? 5000);
      }
    }
    // Daqui em diante o post JÁ está no Instagram: nada abaixo pode marcá-lo como falho.
    await repo.markPublished(post.id, mediaId);
    log?.info({ postId: post.id, mediaId }, 'Publicação feita');

    const info = await ig.getMediaInfo(token, mediaId).catch(() => null);
    if (info?.permalink) await repo.setPermalink(post.id, info.permalink).catch(() => {});

    if (post.automation) {
      try {
        const triggerId = await repo.createCommentTrigger(post, mediaId);
        await repo.setTrigger(post.id, triggerId, null);
      } catch (err) {
        log?.error({ err, postId: post.id }, 'Post publicado, mas o gatilho de comentário falhou');
        await repo
          .setTrigger(post.id, null, `Publicado, mas a automação não foi criada: ${(err as Error).message}. Crie o gatilho em Gatilhos.`)
          .catch(() => {});
      }
    }
    return 'published';
  } catch (err) {
    if (err instanceof IgApiError && err.isAuthError) await repo.markAccountExpired(post.ig_account_id).catch(() => {});
    const message = friendlyPublishError(err);
    log?.warn({ err, postId: post.id }, 'Falha ao publicar');
    await repo.markFailed(post.id, message);
    return 'failed';
  }
}

/** Liga o publicador: procura posts vencidos a cada `intervalMs` (até `maxParallel` ao mesmo tempo). */
export function startPublisher(deps: PublisherDeps, intervalMs: number, maxParallel = 3) {
  const inFlight = new Set<string>();
  let ticking = false;
  let stopped = false;

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const stuck = await deps.repo.requeueStuck();
      if (stuck) deps.log?.warn({ stuck }, 'Publicações interrompidas retomadas');
      const free = maxParallel - inFlight.size;
      if (free <= 0) return;
      for (const post of await deps.repo.claimDue(free)) {
        inFlight.add(post.id);
        void publishPost(deps, post).finally(() => inFlight.delete(post.id));
      }
    } catch (err) {
      deps.log?.error({ err }, 'Erro no publicador');
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  void tick();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Espera um pouco quem está no meio; o resto é retomado no próximo start (requeueStuck)
      for (let i = 0; inFlight.size && i < 20; i++) await defaultSleep(500);
    },
  };
}
