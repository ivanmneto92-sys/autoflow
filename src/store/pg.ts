/** Store em Postgres (Supabase). */
import type postgres from 'postgres';
import { config } from '../config.js';
import { generateCode } from '../lib/coupon.js';
import { linkCode } from '../lib/links.js';
import { normalizeMid } from '../lib/mid.js';
import { decrypt } from '../lib/crypto.js';
import type {
  CouponResult,
  LinkInput,
  OrderInput,
  Account,
  Contact,
  EventLog,
  FlowVersion,
  MessageLog,
  Session,
  Store,
  Trigger,
  TriggerType,
} from './types.js';

type Row = Record<string, any>;

const toAccount = (r: Row): Account => ({
  id: r.id,
  workspaceId: r.workspace_id,
  igUserId: r.ig_user_id,
  username: r.username,
  status: r.status,
  hourlySendLimit: r.hourly_send_limit,
  pageId: r.page_id ?? null,
  settings: r.settings ?? {},
});

const toContact = (r: Row): Contact => ({
  id: r.id,
  workspaceId: r.workspace_id,
  igAccountId: r.ig_account_id,
  igsid: r.igsid,
  username: r.username,
  name: r.name,
  firstName: r.first_name,
  lastInboundAt: r.last_inbound_at,
  botPausedUntil: r.bot_paused_until,
  createdAt: r.created_at,
});

const toSession = (r: Row): Session => ({
  id: r.id,
  workspaceId: r.workspace_id,
  contactId: r.contact_id,
  flowId: r.flow_id,
  flowVersionId: r.flow_version_id,
  status: r.status,
  currentNodeId: r.current_node_id,
  vars: r.vars ?? {},
  waitToken: r.wait_token,
});

const toTrigger = (r: Row): Trigger => ({
  id: r.id,
  workspaceId: r.workspace_id,
  igAccountId: r.ig_account_id,
  flowId: r.flow_id,
  type: r.type,
  config: r.config ?? {},
  priority: r.priority,
});

const toVersion = (r: Row): FlowVersion => ({ id: r.id, flowId: r.flow_id, version: r.version, graph: r.graph });

const sessionCols: Record<string, string> = {
  workspaceId: 'workspace_id',
  contactId: 'contact_id',
  flowId: 'flow_id',
  flowVersionId: 'flow_version_id',
  status: 'status',
  currentNodeId: 'current_node_id',
  vars: 'vars',
  waitToken: 'wait_token',
};

const contactCols: Record<string, string> = {
  name: 'name',
  firstName: 'first_name',
  username: 'username',
  botPausedUntil: 'bot_paused_until',
};

function mapPatch(patch: Record<string, unknown>, cols: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (cols[k] && v !== undefined) out[cols[k]] = v;
  return out;
}

export class PgStore implements Store {
  constructor(private sql: postgres.Sql) {}

  async getAccountByIgUserId(igUserId: string) {
    const [r] = await this.sql`
      select a.*, w.settings from autoflow.ig_accounts a join autoflow.workspaces w on w.id = a.workspace_id
      where a.ig_user_id = ${igUserId}`;
    return r ? toAccount(r) : null;
  }

  async getAccountById(id: string) {
    const [r] = await this.sql`
      select a.*, w.settings from autoflow.ig_accounts a join autoflow.workspaces w on w.id = a.workspace_id where a.id = ${id}`;
    return r ? toAccount(r) : null;
  }

  async getAccessToken(accountId: string) {
    const [r] = await this.sql`select access_token_enc from autoflow.ig_account_tokens where ig_account_id = ${accountId}`;
    if (!r) throw new Error(`Conta ${accountId} sem token`);
    return decrypt(r.access_token_enc, config().ENCRYPTION_KEY);
  }

  async markAccountStatus(accountId: string, status: string) {
    await this.sql`update autoflow.ig_accounts set status = ${status}, updated_at = now() where id = ${accountId}`;
  }

  async upsertContact(account: Account, igsid: string, patch: { username?: string | null; name?: string | null; lastInboundAt?: Date }) {
    const [r] = await this.sql`
      insert into autoflow.contacts (workspace_id, ig_account_id, igsid, username, name, last_inbound_at)
      values (${account.workspaceId}, ${account.id}, ${igsid}, ${patch.username ?? null}, ${patch.name ?? null}, ${patch.lastInboundAt ?? null})
      on conflict (ig_account_id, igsid) do update set
        username = coalesce(excluded.username, contacts.username),
        name = coalesce(excluded.name, contacts.name),
        last_inbound_at = coalesce(excluded.last_inbound_at, contacts.last_inbound_at),
        updated_at = now()
      returning *, (xmax = 0) as created`;
    return { contact: toContact(r!), created: Boolean(r!.created) };
  }

  async updateContact(id: string, patch: Partial<Contact>) {
    const data = mapPatch(patch, contactCols);
    if (!Object.keys(data).length) return;
    await this.sql`update autoflow.contacts set ${this.sql(data)}, updated_at = now() where id = ${id}`;
  }

  async getContact(id: string) {
    const [r] = await this.sql`select * from autoflow.contacts where id = ${id}`;
    return r ? toContact(r) : null;
  }

  async getTags(contactId: string) {
    const rows = await this.sql`
      select t.name from autoflow.contact_tags ct join autoflow.tags t on t.id = ct.tag_id where ct.contact_id = ${contactId}`;
    return rows.map((r) => r.name as string);
  }

  async addTag(workspaceId: string, contactId: string, tag: string) {
    await this.sql`
      with t as (
        insert into autoflow.tags (workspace_id, name) values (${workspaceId}, ${tag})
        on conflict (workspace_id, name) do update set name = excluded.name
        returning id
      )
      insert into autoflow.contact_tags (contact_id, tag_id) select ${contactId}, id from t
      on conflict do nothing`;
  }

  async removeTag(workspaceId: string, contactId: string, tag: string) {
    await this.sql`
      delete from autoflow.contact_tags ct using autoflow.tags t
      where ct.tag_id = t.id and t.workspace_id = ${workspaceId} and t.name = ${tag} and ct.contact_id = ${contactId}`;
  }

  async getFields(contactId: string) {
    const [r] = await this.sql`select values from autoflow.contact_fields where contact_id = ${contactId}`;
    return (r?.values as Record<string, unknown>) ?? {};
  }

  async setField(contactId: string, key: string, value: unknown) {
    const patch = { [key]: value };
    await this.sql`
      insert into autoflow.contact_fields (contact_id, values) values (${contactId}, ${this.sql.json(patch as any)})
      on conflict (contact_id) do update set values = contact_fields.values || excluded.values, updated_at = now()`;
  }

  async getActiveSession(contactId: string) {
    const [r] = await this.sql`
      select * from autoflow.sessions
      where contact_id = ${contactId} and status in ('running','waiting_input','waiting_delay','waiting_window','waiting_payment')
      order by started_at desc limit 1`;
    return r ? toSession(r) : null;
  }

  async getSession(id: string) {
    const [r] = await this.sql`select * from autoflow.sessions where id = ${id}`;
    return r ? toSession(r) : null;
  }

  async createSession(s: Omit<Session, 'id'>) {
    const [r] = await this.sql`
      insert into autoflow.sessions (workspace_id, contact_id, flow_id, flow_version_id, status, current_node_id, vars, wait_token)
      values (${s.workspaceId}, ${s.contactId}, ${s.flowId}, ${s.flowVersionId}, ${s.status}, ${s.currentNodeId},
              ${this.sql.json(s.vars as any)}, ${s.waitToken})
      returning *`;
    return toSession(r!);
  }

  async updateSession(id: string, patch: Partial<Session>) {
    const data = mapPatch(patch, sessionCols);
    if ('vars' in data) data.vars = this.sql.json(data.vars as any);
    const ended = patch.status && ['completed', 'failed', 'cancelled'].includes(patch.status);
    if (!Object.keys(data).length) return;
    await this.sql`
      update autoflow.sessions set ${this.sql(data as Record<string, any>)}, updated_at = now()
      ${ended ? this.sql`, ended_at = now()` : this.sql``}
      where id = ${id}`;
  }

  async cancelActiveSessions(contactId: string) {
    await this.sql`
      update autoflow.sessions set status = 'cancelled', ended_at = now(), updated_at = now()
      where contact_id = ${contactId} and status in ('running','waiting_input','waiting_delay','waiting_window','waiting_payment')`;
  }

  async getFlowVersion(id: string) {
    const [r] = await this.sql`select * from autoflow.flow_versions where id = ${id}`;
    return r ? toVersion(r) : null;
  }

  async getPublishedVersion(flowId: string) {
    const [r] = await this.sql`
      select v.* from autoflow.flows f join autoflow.flow_versions v on v.id = f.published_version_id
      where f.id = ${flowId} and f.status = 'published'`;
    return r ? toVersion(r) : null;
  }

  async listTriggers(workspaceId: string, accountId: string, type: TriggerType) {
    const rows = await this.sql`
      select t.* from autoflow.triggers t join autoflow.flows f on f.id = t.flow_id
      where t.workspace_id = ${workspaceId} and t.type = ${type} and t.enabled
        and f.status = 'published'
        and (t.ig_account_id is null or t.ig_account_id = ${accountId})
      order by t.priority desc, t.created_at asc`;
    return rows.map(toTrigger);
  }

  async getTrigger(id: string) {
    const [r] = await this.sql`select * from autoflow.triggers where id = ${id} and enabled`;
    return r ? toTrigger(r) : null;
  }

  async getLastFire(triggerId: string, contactId: string) {
    const [r] = await this.sql`
      select last_fired_at from autoflow.trigger_fires where trigger_id = ${triggerId} and contact_id = ${contactId}`;
    return r ? (r.last_fired_at as Date) : null;
  }

  async recordFire(triggerId: string, contactId: string, at: Date) {
    await this.sql`
      insert into autoflow.trigger_fires (trigger_id, contact_id, last_fired_at) values (${triggerId}, ${contactId}, ${at})
      on conflict (trigger_id, contact_id) do update set last_fired_at = excluded.last_fired_at, count = trigger_fires.count + 1`;
  }

  async messageExists(mid: string) {
    const [r] = await this.sql`select 1 from autoflow.messages where mid = ${normalizeMid(mid)} or mid = ${mid} limit 1`;
    return Boolean(r);
  }

  async logMessage(m: MessageLog) {
    await this.sql`
      insert into autoflow.messages (workspace_id, contact_id, direction, source, mid, text, payload, session_id)
      values (${m.workspaceId}, ${m.contactId}, ${m.direction}, ${m.source}, ${normalizeMid(m.mid)}, ${m.text ?? null},
              ${m.payload === undefined ? null : this.sql.json(m.payload as any)}, ${m.sessionId ?? null})
      on conflict do nothing`;
  }

  async createOrder(o: OrderInput) {
    // Número sequencial por negócio; se duas inserções colidirem, tenta de novo
    for (let attempt = 0; ; attempt++) {
      try {
        const [r] = await this.sql`
          insert into autoflow.orders (workspace_id, number, contact_id, ig_account_id, flow_id, summary, details, total_cents)
          select ${o.workspaceId}, coalesce(max(number), 0) + 1, ${o.contactId}, ${o.igAccountId}, ${o.flowId},
                 ${o.summary}, ${this.sql.json(o.details)}, ${o.totalCents}
          from autoflow.orders where workspace_id = ${o.workspaceId}
          returning id, number`;
        return { id: r!.id as string, number: r!.number as number };
      } catch (err) {
        if ((err as { code?: string }).code !== '23505' || attempt >= 4) throw err;
      }
    }
  }

  async assignCoupon(workspaceId: string, campaignId: string, contactId: string): Promise<CouponResult> {
    return this.sql.begin(async (tx) => {
      const [camp] = await tx`
        select id, mode, prefix, discount, valid_days from autoflow.coupon_campaigns
        where id = ${campaignId} and workspace_id = ${workspaceId} and not archived
        for share`;
      if (!camp) return { status: 'unavailable' } as const;
      const discount = camp.discount as string;
      const own = async () => {
        const [c] = await tx`select code, expires_at from autoflow.coupons where campaign_id = ${campaignId} and contact_id = ${contactId}`;
        return c ? ({ status: 'existing', code: c.code as string, discount, expiresAt: (c.expires_at as Date | null) ?? null } as const) : null;
      };
      const had = await own();
      if (had) return had;
      const expires = camp.valid_days ? tx`now() + make_interval(days => ${camp.valid_days as number})` : null;

      if (camp.mode === 'list') {
        const [c] = await tx`
          update autoflow.coupons set contact_id = ${contactId}, assigned_at = now(), expires_at = ${expires}
          where id = (select id from autoflow.coupons where campaign_id = ${campaignId} and assigned_at is null
                      order by created_at limit 1 for update skip locked)
          returning code, expires_at`;
        if (!c) return { status: 'sold_out' } as const;
        return { status: 'new', code: c.code as string, discount, expiresAt: (c.expires_at as Date | null) ?? null } as const;
      }

      for (let attempt = 0; attempt < 6; attempt++) {
        const [c] = await tx`
          insert into autoflow.coupons (workspace_id, campaign_id, code, contact_id, assigned_at, expires_at)
          values (${workspaceId}, ${campaignId}, ${generateCode(camp.prefix as string)}, ${contactId}, now(), ${expires})
          on conflict do nothing
          returning code, expires_at`;
        if (c) return { status: 'new', code: c.code as string, discount, expiresAt: (c.expires_at as Date | null) ?? null } as const;
        const raced = await own(); // a mesma pessoa pegou em paralelo
        if (raced) return raced;
      }
      throw new Error('Não consegui gerar um código de cupom único');
    });
  }

  async createLink(l: LinkInput) {
    const [old] = await this.sql`
      select code from autoflow.links
      where contact_id = ${l.contactId} and flow_id = ${l.flowId} and node_id = ${l.nodeId} and url = ${l.url}
      order by created_at desc limit 1`;
    if (old) return old.code as string;
    for (let i = 0; ; i++) {
      const code = linkCode();
      try {
        await this.sql`
          insert into autoflow.links (code, workspace_id, flow_id, node_id, contact_id, url, actions)
          values (${code}, ${l.workspaceId}, ${l.flowId}, ${l.nodeId}, ${l.contactId}, ${l.url},
                  ${l.actions?.length ? this.sql.json(l.actions as any) : null})`;
        return code;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505' || i >= 4) throw err;
      }
    }
  }

  async hasClickedLink(contactId: string, flowId: string, since: Date) {
    const [r] = await this.sql`
      select 1 from autoflow.links where contact_id = ${contactId} and flow_id = ${flowId} and last_clicked_at >= ${since} limit 1`;
    return Boolean(r);
  }

  async logEvent(e: EventLog) {
    await this.sql`
      insert into autoflow.events (workspace_id, contact_id, flow_id, session_id, node_id, type, data)
      values (${e.workspaceId}, ${e.contactId ?? null}, ${e.flowId ?? null}, ${e.sessionId ?? null}, ${e.nodeId ?? null},
              ${e.type}, ${e.data === undefined ? null : this.sql.json(e.data as any)})`;
  }
}
