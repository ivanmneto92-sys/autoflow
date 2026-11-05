import { describe, expect, it } from 'vitest';
import { IgApiError } from '../src/instagram/client.js';
import { friendlyPublishError, publishPost, type DuePost, type PostRepo, type PublishClient } from '../src/posts/publisher.js';
import { checkPostRules, PostInputSchema } from '../src/posts/schema.js';

class MemRepo implements PostRepo {
  account: { igUserId: string; status: string } | null = { igUserId: '1784', status: 'active' };
  log: string[] = [];
  state: Record<string, unknown> = {};
  triggerFails = false;
  async claimDue() {
    return [];
  }
  async requeueStuck() {
    return 0;
  }
  async getAccount() {
    return this.account;
  }
  async getToken() {
    return 'EAA_token';
  }
  async markAccountExpired() {
    this.log.push('expired');
  }
  async setContainer(_id: string, c: string | null) {
    this.log.push(`container:${c}`);
  }
  async heartbeat() {
    this.log.push('hb');
  }
  async markPublished(_id: string, mediaId: string) {
    this.state.status = 'published';
    this.state.mediaId = mediaId;
  }
  async setPermalink(_id: string, p: string) {
    this.state.permalink = p;
  }
  async createCommentTrigger(post: DuePost, mediaId: string) {
    if (this.triggerFails) throw new Error('o fluxo escolhido não existe mais');
    this.state.trigger = { mediaId, keywords: post.automation?.keywords };
    return 'trig_1';
  }
  async setTrigger(_id: string, t: string | null, w: string | null) {
    this.state.triggerId = t;
    this.state.warning = w;
  }
  async markFailed(_id: string, error: string) {
    this.state.status = 'failed';
    this.state.error = error;
  }
}

class FakePublisher implements PublishClient {
  created: Record<string, string>[] = [];
  statuses: string[] = [];
  publishErrors: unknown[] = [];
  published = 0;
  createError: unknown = null;
  async createMediaContainer(_t: string, _ig: string, params: Record<string, string>) {
    if (this.createError) throw this.createError;
    this.created.push(params);
    return { id: `c${this.created.length}` };
  }
  async getContainerStatus() {
    return { status_code: this.statuses.shift() ?? 'FINISHED' };
  }
  async publishMedia() {
    const e = this.publishErrors.shift();
    if (e) throw e;
    this.published++;
    return { id: 'media_99' };
  }
  async getMediaInfo() {
    return { id: 'media_99', permalink: 'https://www.instagram.com/p/abc/' };
  }
}

const post = (over: Partial<DuePost> = {}): DuePost => ({
  id: 'p1',
  workspace_id: 'w1',
  ig_account_id: 'a1',
  media_type: 'IMAGE',
  media: [{ url: 'https://api.test/media/w/x.jpg', kind: 'image' }],
  caption: 'Comenta AUTOFLOW',
  automation: { flow_id: '00000000-0000-4000-8000-000000000001', keywords: ['autoflow'], match: 'contains', public_replies: [], once_per_contact: true },
  ig_container_id: null,
  ...over,
});

const deps = (repo: MemRepo, ig: FakePublisher) => ({ repo, ig, sleep: async () => {}, pollMs: 1 });

describe('publicador de posts', () => {
  it('imagem: cria contêiner, publica e cria o gatilho só para aquele post', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    expect(await publishPost(deps(repo, ig), post())).toBe('published');
    expect(ig.created[0]).toEqual({ image_url: 'https://api.test/media/w/x.jpg', caption: 'Comenta AUTOFLOW' });
    expect(repo.state).toMatchObject({
      status: 'published',
      mediaId: 'media_99',
      permalink: 'https://www.instagram.com/p/abc/',
      trigger: { mediaId: 'media_99', keywords: ['autoflow'] },
      triggerId: 'trig_1',
      warning: null,
    });
  });

  it('reels: espera processar (com heartbeat) antes de publicar', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const p = post({ media_type: 'REELS', media: [{ url: 'https://api.test/media/w/v.mp4', kind: 'video' }], automation: null });
    expect(await publishPost(deps(repo, ig), p)).toBe('published');
    expect(ig.created[0]).toMatchObject({ media_type: 'REELS', video_url: 'https://api.test/media/w/v.mp4', share_to_feed: 'true' });
    expect(repo.log.filter((l) => l === 'hb').length).toBe(2);
    expect(repo.state.trigger).toBeUndefined();
  });

  it('mídia recusada pela Meta: falha sem publicar', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.statuses = ['ERROR'];
    expect(await publishPost(deps(repo, ig), post())).toBe('failed');
    expect(ig.published).toBe(0);
    expect(repo.state.error).toMatch(/não conseguiu processar a mídia/);
  });

  it('"mídia ainda não está pronta" (9007): tenta publicar de novo', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.publishErrors = [new IgApiError('Media ID is not available', 400, 9007, 2207027)];
    expect(await publishPost(deps(repo, ig), post())).toBe('published');
    expect(ig.published).toBe(1);
  });

  it('retoma com o contêiner que já existia (sem criar outro)', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    expect(await publishPost(deps(repo, ig), post({ ig_container_id: 'c_old' }))).toBe('published');
    expect(ig.created.length).toBe(0);
  });

  it('contêiner expirado: cria um novo', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.statuses = ['EXPIRED', 'FINISHED'];
    expect(await publishPost(deps(repo, ig), post({ ig_container_id: 'c_old' }))).toBe('published');
    expect(ig.created.length).toBe(1);
    expect(repo.log).toContain('container:null');
  });

  it('contêiner já publicado (worker caiu no meio): não publica de novo', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.statuses = ['PUBLISHED'];
    expect(await publishPost(deps(repo, ig), post({ ig_container_id: 'c_old' }))).toBe('failed');
    expect(ig.published).toBe(0);
    expect(repo.state.error).toMatch(/já saiu/);
  });

  it('token expirado: marca a conta e pede reconexão', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.createError = new IgApiError('Error validating access token', 400, 190);
    expect(await publishPost(deps(repo, ig), post())).toBe('failed');
    expect(repo.log).toContain('expired');
    expect(repo.state.error).toMatch(/Reconecte a conta/);
  });

  it('sem permissão de publicar: mensagem clara', async () => {
    const repo = new MemRepo();
    const ig = new FakePublisher();
    ig.createError = new IgApiError('Application does not have permission for this action', 400, 10);
    expect(await publishPost(deps(repo, ig), post())).toBe('failed');
    expect(repo.state.error).toMatch(/permissão de publicar/);
  });

  it('conta desconectada: nem chama a Meta', async () => {
    const repo = new MemRepo();
    repo.account = { igUserId: '1784', status: 'disconnected' };
    const ig = new FakePublisher();
    expect(await publishPost(deps(repo, ig), post())).toBe('failed');
    expect(ig.created.length).toBe(0);
  });

  it('gatilho falhou: o post continua como publicado, com aviso', async () => {
    const repo = new MemRepo();
    repo.triggerFails = true;
    const ig = new FakePublisher();
    expect(await publishPost(deps(repo, ig), post())).toBe('published');
    expect(repo.state.status).toBe('published');
    expect(repo.state.warning).toMatch(/automação não foi criada/);
  });

  it('erro genérico vira mensagem legível', () => {
    expect(friendlyPublishError(new IgApiError('Invalid parameter', 400, 100))).toBe('A Meta recusou a publicação: Invalid parameter');
  });
});

describe('regras da publicação', () => {
  const base = {
    ig_account_id: '00000000-0000-4000-8000-000000000002',
    media_type: 'IMAGE',
    media: [{ url: 'https://api.test/media/w/x.jpg', kind: 'image' }],
  };
  it('tipo de mídia precisa bater', () => {
    expect(checkPostRules(PostInputSchema.parse({ ...base, media_type: 'REELS' }))).toMatch(/Reels precisa/);
    expect(checkPostRules(PostInputSchema.parse(base))).toBeNull();
  });
  it('limite de 30 hashtags', () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    expect(checkPostRules(PostInputSchema.parse({ ...base, caption }))).toMatch(/31 hashtags/);
  });
  it('automação: palavras vazias são recusadas e padrões preenchidos', () => {
    const parsed = PostInputSchema.parse({ ...base, automation: { flow_id: '00000000-0000-4000-8000-000000000001' } });
    expect(parsed.automation).toEqual({ flow_id: '00000000-0000-4000-8000-000000000001', keywords: [], match: 'contains', public_replies: [], once_per_contact: false });
    expect(() => PostInputSchema.parse({ ...base, automation: { flow_id: '00000000-0000-4000-8000-000000000001', keywords: ['  '] } })).toThrow();
  });
});
