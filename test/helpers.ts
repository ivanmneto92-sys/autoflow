import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine/engine.js';
import type { ScheduledJob } from '../src/engine/types.js';
import type { FlowGraph } from '../src/flow/schema.js';
import { parseTriggerConfig } from '../src/flow/triggers.js';
import type { IgClient, OutMessage, Recipient } from '../src/instagram/client.js';
import { MemoryStore } from '../src/store/memory.js';
import type { Account, TriggerType } from '../src/store/types.js';

export const IG_BIZ = '17841400000000001';

export class FakeIg implements IgClient {
  sent: { to: Recipient; msg: OutMessage }[] = [];
  publicReplies: { commentId: string; text: string }[] = [];
  n = 0;
  async sendMessage(_t: string, _ig: string, to: Recipient, msg: OutMessage) {
    this.sent.push({ to, msg });
    return { messageId: `m_bot_${process.pid}_${Date.now()}_${++this.n}` };
  }
  async replyToComment(_t: string, commentId: string, text: string) {
    this.publicReplies.push({ commentId, text });
    return { id: 'r1' };
  }
  async getUserProfile() {
    return { name: 'Maria Silva', username: 'maria.silva' };
  }
  followers = new Set<string>();
  followError = false;
  async getFollowStatus(_t: string, igsid: string) {
    if (this.followError) throw new Error('User consent is required to access user profile');
    return this.followers.has(igsid);
  }
}

export function setup(opts: { quota?: boolean; settings?: Account['settings']; now?: Date; linkBase?: string } = {}) {
  const store = new MemoryStore();
  const ig = new FakeIg();
  const scheduled: { job: ScheduledJob; delayMs: number }[] = [];
  let now = opts.now ?? new Date('2026-11-06T22:00:00Z'); // sexta 19h em SP
  const account: Account = {
    id: 'acc-1',
    workspaceId: 'ws-1',
    igUserId: IG_BIZ,
    username: 'pizzaria',
    status: 'active',
    hourlySendLimit: 190,
    settings: opts.settings ?? { timezone: 'America/Sao_Paulo', bot_pause_hours: 12 },
  };
  store.accounts.push(account);
  const engine = new Engine({
    store,
    ig,
    consumeQuota: async () => opts.quota ?? true,
    scheduler: { schedule: async (job, delayMs) => void scheduled.push({ job, delayMs }) },
    now: () => now,
    linkBase: opts.linkBase,
  });
  let tid = 0;
  const addFlow = (graph: FlowGraph, flowId = `flow-${Math.random().toString(36).slice(2, 8)}`) => {
    const v = store.addVersion(flowId, graph);
    return { flowId, version: v };
  };
  const addTrigger = (flowId: string, type: TriggerType, config: unknown = {}, priority = 0) => {
    const t = {
      id: `trg-${++tid}`,
      workspaceId: 'ws-1',
      igAccountId: null,
      flowId,
      type,
      config: parseTriggerConfig(type, config) as Record<string, unknown>,
      priority,
    };
    store.triggers.push(t);
    return t;
  };
  return {
    store,
    ig,
    engine,
    account,
    scheduled,
    addFlow,
    addTrigger,
    setNow: (d: Date) => (now = d),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

let mid = 0;
export const dm = (text: string, senderId = 'user-1', quickReplyPayload?: string) => ({
  kind: 'dm' as const,
  igUserId: IG_BIZ,
  senderId,
  mid: `m_in_${++mid}`,
  text,
  quickReplyPayload,
  timestamp: Date.now(),
});
export const postback = (payload: string, senderId = 'user-1', title = '') => ({
  kind: 'postback' as const,
  igUserId: IG_BIZ,
  senderId,
  mid: `m_pb_${++mid}`,
  payload,
  title,
  timestamp: Date.now(),
});
export const comment = (text: string, fromId = 'user-1', mediaId = 'media-1') => ({
  kind: 'comment' as const,
  igUserId: IG_BIZ,
  commentId: `c_${++mid}`,
  text,
  fromId,
  fromUsername: 'maria.silva',
  mediaId,
  timestamp: Date.now(),
});

export function loadTemplate() {
  return JSON.parse(readFileSync('templates/restaurante.json', 'utf8')) as {
    flow: FlowGraph;
    triggers: { type: TriggerType; priority: number; config: unknown }[];
  };
}

export const textOf = (m: OutMessage) => ('text' in m ? m.text : '');
