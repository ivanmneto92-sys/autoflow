/** Implementação Postgres do acesso usado pelo publicador. */
import type postgres from 'postgres';
import type { PgStore } from '../store/pg.js';
import type { DuePost, PostRepo } from './publisher.js';

const MAX_ATTEMPTS = 4;

export class PgPostRepo implements PostRepo {
  constructor(
    private sql: postgres.Sql,
    private store: PgStore,
  ) {}

  async claimDue(limit: number): Promise<DuePost[]> {
    const rows = await this.sql`
      update autoflow.scheduled_posts p set status = 'publishing', attempts = p.attempts + 1, error = null, updated_at = now()
      where p.id in (
        select id from autoflow.scheduled_posts
        where status = 'scheduled' and scheduled_at <= now()
        order by scheduled_at
        limit ${limit}
        for update skip locked
      )
      returning p.id, p.workspace_id, p.ig_account_id, p.media_type, p.media, p.caption, p.automation, p.ig_container_id`;
    return rows as unknown as DuePost[];
  }

  async requeueStuck(): Promise<number> {
    const failed = await this.sql`
      update autoflow.scheduled_posts set status = 'failed', updated_at = now(),
        error = 'A publicação foi interrompida várias vezes. Confira no Instagram se ela saiu antes de tentar de novo.'
      where status = 'publishing' and ig_media_id is null and updated_at < now() - interval '5 minutes'
        and attempts >= ${MAX_ATTEMPTS}
      returning id`;
    const requeued = await this.sql`
      update autoflow.scheduled_posts set status = 'scheduled', updated_at = now()
      where status = 'publishing' and ig_media_id is null and updated_at < now() - interval '5 minutes'
      returning id`;
    return failed.length + requeued.length;
  }

  async getAccount(accountId: string) {
    const [r] = await this.sql`select ig_user_id, status from autoflow.ig_accounts where id = ${accountId}`;
    return r ? { igUserId: r.ig_user_id as string, status: r.status as string } : null;
  }

  getToken(accountId: string) {
    return this.store.getAccessToken(accountId);
  }

  async markAccountExpired(accountId: string) {
    await this.store.markAccountStatus(accountId, 'token_expired');
  }

  async setContainer(postId: string, containerId: string | null) {
    await this.sql`update autoflow.scheduled_posts set ig_container_id = ${containerId}, updated_at = now() where id = ${postId}`;
  }

  async heartbeat(postId: string) {
    await this.sql`update autoflow.scheduled_posts set updated_at = now() where id = ${postId}`;
  }

  async markPublished(postId: string, mediaId: string) {
    await this.sql`
      update autoflow.scheduled_posts set status = 'published', ig_media_id = ${mediaId}, error = null,
        published_at = now(), updated_at = now()
      where id = ${postId}`;
  }

  async setPermalink(postId: string, permalink: string) {
    await this.sql`update autoflow.scheduled_posts set permalink = ${permalink} where id = ${postId}`;
  }

  async createCommentTrigger(post: DuePost, mediaId: string): Promise<string> {
    const a = post.automation!;
    const [flow] = await this.sql`
      select id from autoflow.flows where id = ${a.flow_id} and workspace_id = ${post.workspace_id} and status <> 'archived'`;
    if (!flow) throw new Error('o fluxo escolhido não existe mais');
    const config = {
      media_id: mediaId,
      keywords: a.keywords,
      match: a.match,
      public_replies: a.public_replies,
      once_per_contact: a.once_per_contact,
    };
    // Prioridade alta: o gatilho do post específico vence os gatilhos de "qualquer post"
    const [t] = await this.sql`
      insert into autoflow.triggers (workspace_id, ig_account_id, flow_id, type, config, priority, enabled)
      values (${post.workspace_id}, ${post.ig_account_id}, ${a.flow_id}, 'comment', ${this.sql.json(config)}, 100, true)
      returning id`;
    return t!.id as string;
  }

  async setTrigger(postId: string, triggerId: string | null, warning: string | null) {
    await this.sql`update autoflow.scheduled_posts set trigger_id = ${triggerId}, error = ${warning}, updated_at = now() where id = ${postId}`;
  }

  async markFailed(postId: string, error: string) {
    await this.sql`update autoflow.scheduled_posts set status = 'failed', error = ${error}, updated_at = now() where id = ${postId}`;
  }
}
