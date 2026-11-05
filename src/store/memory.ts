/** Store em memória — usado nos testes e para simular fluxos sem banco. */
import { randomUUID } from 'node:crypto';
import type { FlowGraph } from '../flow/schema.js';
import type {
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
import { ACTIVE_STATUSES } from './types.js';

export class MemoryStore implements Store {
  accounts: Account[] = [];
  tokens = new Map<string, string>();
  contacts: Contact[] = [];
  tags = new Map<string, Set<string>>();
  fields = new Map<string, Record<string, unknown>>();
  sessions: Session[] = [];
  versions: FlowVersion[] = [];
  published = new Map<string, string>(); // flowId -> versionId
  triggers: Trigger[] = [];
  fires = new Map<string, Date>();
  messages: (MessageLog & { createdAt: Date })[] = [];
  events: EventLog[] = [];

  async getAccountByIgUserId(igUserId: string) {
    return this.accounts.find((a) => a.igUserId === igUserId) ?? null;
  }
  async getAccountById(id: string) {
    return this.accounts.find((a) => a.id === id) ?? null;
  }
  async getAccessToken(accountId: string) {
    return this.tokens.get(accountId) ?? 'test-token';
  }
  async markAccountStatus(accountId: string, status: string) {
    const a = this.accounts.find((x) => x.id === accountId);
    if (a) a.status = status;
  }

  async upsertContact(account: Account, igsid: string, patch: { username?: string | null; name?: string | null; lastInboundAt?: Date }) {
    let c = this.contacts.find((x) => x.igAccountId === account.id && x.igsid === igsid);
    const created = !c;
    if (!c) {
      c = {
        id: randomUUID(),
        workspaceId: account.workspaceId,
        igAccountId: account.id,
        igsid,
        username: null,
        name: null,
        firstName: null,
        lastInboundAt: null,
        botPausedUntil: null,
        createdAt: new Date(),
      };
      this.contacts.push(c);
    }
    if (patch.username) c.username = patch.username;
    if (patch.name) c.name = patch.name;
    if (patch.lastInboundAt) c.lastInboundAt = patch.lastInboundAt;
    return { contact: { ...c }, created };
  }
  async updateContact(id: string, patch: Partial<Contact>) {
    const c = this.contacts.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  }
  async getContact(id: string) {
    const c = this.contacts.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  async getTags(contactId: string) {
    return [...(this.tags.get(contactId) ?? [])];
  }
  async addTag(_ws: string, contactId: string, tag: string) {
    if (!this.tags.has(contactId)) this.tags.set(contactId, new Set());
    this.tags.get(contactId)!.add(tag);
  }
  async removeTag(_ws: string, contactId: string, tag: string) {
    this.tags.get(contactId)?.delete(tag);
  }
  async getFields(contactId: string) {
    return { ...(this.fields.get(contactId) ?? {}) };
  }
  async setField(contactId: string, key: string, value: unknown) {
    this.fields.set(contactId, { ...(this.fields.get(contactId) ?? {}), [key]: value });
  }

  async getActiveSession(contactId: string) {
    const s = [...this.sessions].reverse().find((x) => x.contactId === contactId && ACTIVE_STATUSES.includes(x.status));
    return s ? structuredClone(s) : null;
  }
  async getSession(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    return s ? structuredClone(s) : null;
  }
  async createSession(s: Omit<Session, 'id'>) {
    const session = { ...structuredClone(s), id: randomUUID() };
    this.sessions.push(session);
    return structuredClone(session);
  }
  async updateSession(id: string, patch: Partial<Session>) {
    const s = this.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, structuredClone(patch));
  }
  async cancelActiveSessions(contactId: string) {
    for (const s of this.sessions)
      if (s.contactId === contactId && ACTIVE_STATUSES.includes(s.status)) s.status = 'cancelled';
  }

  async getFlowVersion(id: string) {
    return this.versions.find((v) => v.id === id) ?? null;
  }
  async getPublishedVersion(flowId: string) {
    const id = this.published.get(flowId);
    return id ? this.getFlowVersion(id) : null;
  }

  async listTriggers(workspaceId: string, accountId: string, type: TriggerType) {
    return this.triggers
      .filter((t) => t.workspaceId === workspaceId && t.type === type && (!t.igAccountId || t.igAccountId === accountId))
      .sort((a, b) => b.priority - a.priority);
  }
  async getTrigger(id: string) {
    return this.triggers.find((t) => t.id === id) ?? null;
  }
  async getLastFire(triggerId: string, contactId: string) {
    return this.fires.get(`${triggerId}:${contactId}`) ?? null;
  }
  async recordFire(triggerId: string, contactId: string, at: Date) {
    this.fires.set(`${triggerId}:${contactId}`, at);
  }

  async messageExists(mid: string) {
    return this.messages.some((m) => m.mid === mid);
  }
  async logMessage(m: MessageLog) {
    this.messages.push({ ...m, createdAt: new Date() });
  }
  async logEvent(e: EventLog) {
    this.events.push(e);
  }

  // Helpers de teste
  addVersion(flowId: string, graph: FlowGraph, publish = true): FlowVersion {
    const v = { id: randomUUID(), flowId, version: this.versions.filter((x) => x.flowId === flowId).length + 1, graph };
    this.versions.push(v);
    if (publish) this.published.set(flowId, v.id);
    return v;
  }
}

