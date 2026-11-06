import type { FlowGraph } from '../flow/schema.js';
import type { BusinessHours } from '../lib/businessHours.js';

export interface WorkspaceSettings {
  /** WhatsApp do negócio (só números com DDI) — usado em {{whatsapp}} nos links */
  whatsapp?: string;
  timezone?: string;
  business_hours?: BusinessHours;
  bot_pause_hours?: number;
}

export interface Account {
  id: string;
  workspaceId: string;
  igUserId: string;
  username: string | null;
  status: string;
  hourlySendLimit: number;
  /** Página do Facebook ligada (modo login unificado). Envio usa a Página quando existe. */
  pageId?: string | null;
  settings: WorkspaceSettings;
}

export interface Contact {
  id: string;
  workspaceId: string;
  igAccountId: string;
  igsid: string;
  username: string | null;
  name: string | null;
  firstName: string | null;
  lastInboundAt: Date | null;
  botPausedUntil: Date | null;
  createdAt: Date;
}

export type SessionStatus =
  | 'running'
  | 'waiting_input'
  | 'waiting_delay'
  | 'waiting_window'
  | 'waiting_payment'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const ACTIVE_STATUSES: SessionStatus[] = ['running', 'waiting_input', 'waiting_delay', 'waiting_window', 'waiting_payment'];

export interface Session {
  id: string;
  workspaceId: string;
  contactId: string;
  flowId: string;
  flowVersionId: string;
  status: SessionStatus;
  currentNodeId: string | null;
  vars: Record<string, unknown>;
  waitToken: string | null;
}

export interface FlowVersion {
  id: string;
  flowId: string;
  version: number;
  graph: FlowGraph;
}

export type TriggerType =
  | 'comment'
  | 'dm_keyword'
  | 'story_mention'
  | 'story_reply'
  | 'ref_link'
  | 'ad_click'
  | 'postback'
  | 'default_reply';

export interface Trigger {
  id: string;
  workspaceId: string;
  igAccountId: string | null;
  flowId: string;
  type: TriggerType;
  config: Record<string, unknown>;
  priority: number;
}

export interface MessageLog {
  workspaceId: string;
  contactId: string;
  direction: 'in' | 'out';
  source: 'user' | 'bot' | 'human' | 'comment';
  mid?: string | null;
  text?: string | null;
  payload?: unknown;
  sessionId?: string | null;
}

export interface OrderInput {
  workspaceId: string;
  contactId: string;
  igAccountId: string;
  flowId: string | null;
  summary: string;
  details: { label: string; value: string }[];
  totalCents: number | null;
}

/** Resultado de "entregar cupom": novo, a pessoa já tinha, acabaram os códigos ou campanha inexistente/arquivada. */
export type CouponResult =
  | { status: 'new' | 'existing'; code: string; discount: string; expiresAt: Date | null }
  | { status: 'sold_out' | 'unavailable' };

export interface EventLog {
  workspaceId: string;
  contactId?: string | null;
  flowId?: string | null;
  sessionId?: string | null;
  nodeId?: string | null;
  type: string;
  data?: unknown;
}

/** Camada de dados usada pelo motor. Implementações: Postgres (produção) e memória (testes). */
export interface Store {
  getAccountByIgUserId(igUserId: string): Promise<Account | null>;
  getAccountById(id: string): Promise<Account | null>;
  getAccessToken(accountId: string): Promise<string>;
  markAccountStatus(accountId: string, status: string): Promise<void>;

  upsertContact(
    account: Account,
    igsid: string,
    patch: { username?: string | null; name?: string | null; lastInboundAt?: Date },
  ): Promise<{ contact: Contact; created: boolean }>;
  updateContact(id: string, patch: Partial<Pick<Contact, 'name' | 'firstName' | 'username' | 'botPausedUntil'>>): Promise<void>;
  getContact(id: string): Promise<Contact | null>;

  getTags(contactId: string): Promise<string[]>;
  addTag(workspaceId: string, contactId: string, tag: string): Promise<void>;
  removeTag(workspaceId: string, contactId: string, tag: string): Promise<void>;
  getFields(contactId: string): Promise<Record<string, unknown>>;
  setField(contactId: string, key: string, value: unknown): Promise<void>;

  getActiveSession(contactId: string): Promise<Session | null>;
  getSession(id: string): Promise<Session | null>;
  createSession(s: Omit<Session, 'id'>): Promise<Session>;
  updateSession(id: string, patch: Partial<Omit<Session, 'id'>>): Promise<void>;
  cancelActiveSessions(contactId: string): Promise<void>;

  getFlowVersion(id: string): Promise<FlowVersion | null>;
  getPublishedVersion(flowId: string): Promise<FlowVersion | null>;

  listTriggers(workspaceId: string, accountId: string, type: TriggerType): Promise<Trigger[]>;
  getTrigger(id: string): Promise<Trigger | null>;
  getLastFire(triggerId: string, contactId: string): Promise<Date | null>;
  recordFire(triggerId: string, contactId: string, at: Date): Promise<void>;

  messageExists(mid: string): Promise<boolean>;
  logMessage(m: MessageLog): Promise<void>;
  logEvent(e: EventLog): Promise<void>;
  /** Cria um pedido com número sequencial por negócio. */
  createOrder(o: OrderInput): Promise<{ id: string; number: number }>;
  assignCoupon(workspaceId: string, campaignId: string, contactId: string): Promise<CouponResult>;
}
