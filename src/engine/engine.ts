/**
 * Motor de fluxos: recebe eventos normalizados do Instagram, encontra o gatilho/sessão
 * e executa os nós do grafo até precisar esperar (resposta, atraso, janela) ou terminar.
 */
import { randomUUID } from 'node:crypto';
import type { ButtonAction, FlowGraph, FlowNode } from '../flow/schema.js';
import { parsePayload } from '../flow/schema.js';
import { IgApiError, type OutMessage, type Recipient } from '../instagram/client.js';
import type { InboundEvent, Referral } from '../instagram/webhook.js';
import { matchAny, pickRandom, type MatchType } from '../lib/text.js';
import type { Account, Contact, FlowVersion, Session, Trigger } from '../store/types.js';
import { executeNode, type NodeResult } from './nodes.js';
import { MAX_STEPS, WINDOW_MS, type EngineDeps, type ScheduledJob } from './types.js';

export class WindowClosedError extends Error {}
export class QuotaExceededError extends Error {}

/** Contexto de uma execução (uma "rodada" do fluxo para um contato). */
export interface RunContext {
  deps: EngineDeps;
  account: Account;
  contact: Contact;
  session: Session;
  version: FlowVersion;
  graph: FlowGraph;
  /** Primeira mensagem de um fluxo iniciado por comentário vai como resposta privada */
  privateReplyCommentId?: string;
  send(msg: OutMessage, nodeId: string): Promise<void>;
  now(): Date;
}

export class Engine {
  constructor(private deps: EngineDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ─────────────────────────── Entrada de eventos ───────────────────────────

  async handleEvent(e: InboundEvent): Promise<void> {
    const { store } = this.deps;
    const account = await store.getAccountByIgUserId(e.igUserId);
    if (!account || account.status !== 'active') return;

    switch (e.kind) {
      case 'echo':
        return this.onEcho(account, e);
      case 'comment':
        return this.onComment(account, e);
      default:
        return this.onMessage(account, e);
    }
  }

  /** Mensagem enviada pela própria conta. Se não foi o bot, um humano respondeu → pausa o robô. */
  private async onEcho(account: Account, e: Extract<InboundEvent, { kind: 'echo' }>) {
    const { store } = this.deps;
    if (await store.messageExists(e.mid)) return; // enviada pelo bot
    const { contact } = await store.upsertContact(account, e.recipientId, {});
    await store.logMessage({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      direction: 'out',
      source: 'human',
      mid: e.mid,
      text: e.text,
    });
    await this.pauseBot(account, contact);
  }

  private async pauseBot(account: Account, contact: Contact) {
    const hours = account.settings.bot_pause_hours ?? 12;
    if (hours <= 0) return;
    await this.deps.store.updateContact(contact.id, {
      botPausedUntil: new Date(this.now().getTime() + hours * 3_600_000),
    });
    await this.deps.store.cancelActiveSessions(contact.id);
  }

  private isPaused(contact: Contact): boolean {
    return Boolean(contact.botPausedUntil && contact.botPausedUntil > this.now());
  }

  private async onComment(account: Account, e: Extract<InboundEvent, { kind: 'comment' }>) {
    const { store, ig } = this.deps;
    if (e.fromId === account.igUserId) return; // comentário da própria conta (ex.: nossa resposta pública)

    const { contact, created } = await store.upsertContact(account, e.fromId, { username: e.fromUsername ?? null });
    await store.logMessage({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      direction: 'in',
      source: 'comment',
      mid: `comment:${e.commentId}`,
      text: e.text,
      payload: { media_id: e.mediaId },
    });
    if (this.isPaused(contact)) return;

    const triggers = await store.listTriggers(account.workspaceId, account.id, 'comment');
    for (const t of triggers) {
      const cfg = t.config as {
        media_id?: string | null;
        keywords?: string[];
        match?: MatchType;
        public_replies?: string[];
        once_per_contact?: boolean;
      };
      if (cfg.media_id && cfg.media_id !== e.mediaId) continue;
      const keywords = cfg.keywords ?? [];
      const match: MatchType = keywords.length ? (cfg.match ?? 'contains') : 'any';
      if (!matchAny(e.text, keywords, match)) continue;
      if (cfg.once_per_contact && (await store.getLastFire(t.id, contact.id))) continue;

      const token = await store.getAccessToken(account.id);
      const reply = pickRandom(cfg.public_replies ?? []);
      if (reply) {
        try {
          await ig.replyToComment(token, e.commentId, reply);
        } catch (err) {
          this.deps.log?.warn({ err, commentId: e.commentId }, 'Falha na resposta pública ao comentário');
        }
      }

      await store.recordFire(t.id, contact.id, this.now());
      await this.startFlow(account, contact, t.flowId, {
        trigger: t,
        isNewContact: created,
        privateReplyCommentId: e.commentId,
        lastText: e.text,
      });
      return; // só o gatilho de maior prioridade
    }
  }

  private async onMessage(account: Account, e: Exclude<InboundEvent, { kind: 'echo' | 'comment' }>) {
    const { store, ig } = this.deps;
    const { contact, created } = await store.upsertContact(account, e.senderId, { lastInboundAt: this.now() });

    const text = e.kind === 'dm' ? e.text : e.kind === 'postback' ? (e.title ?? '') : '';
    await store.logMessage({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      direction: 'in',
      source: 'user',
      mid: e.mid,
      text: text || null,
      payload:
        e.kind === 'postback'
          ? { postback: e.payload }
          : e.kind === 'dm' && e.quickReplyPayload
            ? { quick_reply: e.quickReplyPayload }
            : e.kind === 'story_mention'
              ? { story_mention: e.url }
              : e.kind === 'referral'
                ? { referral: e.referral }
                : e.kind === 'dm' && (e.storyReply || e.referral)
                  ? { ...(e.storyReply ? { story_reply: e.storyReply.url ?? true } : {}), ...(e.referral ? { referral: e.referral } : {}) }
                  : undefined,
    });

    // Completa nome/username na primeira interação (melhor esforço)
    if (created || !contact.username) {
      try {
        const token = await store.getAccessToken(account.id);
        const p = await ig.getUserProfile(token, e.senderId);
        const firstName = p.name?.split(' ')[0] ?? null;
        await store.updateContact(contact.id, { name: p.name ?? null, username: p.username ?? null, firstName });
        Object.assign(contact, { name: p.name ?? contact.name, username: p.username ?? contact.username, firstName });
      } catch {
        /* perfil pode não estar disponível */
      }
    }

    if (this.isPaused(contact)) return;

    const payloadStr = e.kind === 'postback' ? e.payload : e.kind === 'dm' ? e.quickReplyPayload : undefined;
    if (payloadStr) {
      if (await this.onPayload(account, contact, payloadStr, created, text)) return;
    }

    // Veio de anúncio ou de link ig.me com ref → gatilho de entrada tem prioridade
    const referral = e.kind === 'referral' ? e.referral : e.kind === 'dm' ? e.referral : undefined;
    if (referral) {
      if (await this.onReferral(account, contact, referral, created, text)) return;
      if (e.kind === 'referral') return; // só abriu a conversa: sem gatilho, não responde
    }

    const active = await store.getActiveSession(contact.id);

    // Esperando o Pix e o cliente escreveu ("paguei"): confere o pagamento na hora
    if (active?.status === 'waiting_payment' && typeof active.vars.__payment_id === 'string') {
      await this.deps.scheduler.schedule({ kind: 'payment_update', sessionId: active.id, paymentId: active.vars.__payment_id }, 0);
    }

    if (e.kind === 'dm' && active) {
      if (active.status === 'waiting_input') return this.onAnswer(account, contact, active, e.text);
      if (active.status === 'waiting_window') {
        // Cliente respondeu → janela aberta → continua de onde parou
        return this.continueSession(account, contact, active, active.currentNodeId, { lastText: e.text });
      }
    }

    if (e.kind === 'story_mention') {
      const [t] = await store.listTriggers(account.workspaceId, account.id, 'story_mention');
      if (t) await this.fire(account, contact, t, created, '');
      return;
    }

    if (e.kind === 'dm' && e.storyReply) {
      const triggers = await store.listTriggers(account.workspaceId, account.id, 'story_reply');
      for (const t of triggers) {
        const cfg = t.config as { keywords?: string[]; match?: MatchType };
        if (!cfg.keywords?.length || matchAny(e.text, cfg.keywords, cfg.match ?? 'contains')) {
          return this.fire(account, contact, t, created, e.text);
        }
      }
    }

    if (e.kind === 'dm' && e.text) {
      const triggers = await store.listTriggers(account.workspaceId, account.id, 'dm_keyword');
      for (const t of triggers) {
        const cfg = t.config as { keywords?: string[]; match?: MatchType };
        if (cfg.keywords?.length && matchAny(e.text, cfg.keywords, cfg.match ?? 'contains')) {
          return this.fire(account, contact, t, created, e.text);
        }
      }
    }

    // Se já há uma sessão rodando/aguardando atraso, não interrompe com a resposta padrão
    if (active && active.status !== 'waiting_window') return;

    const [def] = await store.listTriggers(account.workspaceId, account.id, 'default_reply');
    if (def) {
      const cooldown = Number((def.config as { cooldown_minutes?: number }).cooldown_minutes ?? 60);
      const last = await store.getLastFire(def.id, contact.id);
      if (!last || this.now().getTime() - last.getTime() >= cooldown * 60_000) {
        await this.fire(account, contact, def, created, text);
      }
    }
  }

  /** Entrada por link ig.me com ref ou por anúncio. Retorna true se algum gatilho disparou. */
  private async onReferral(account: Account, contact: Contact, r: Referral, created: boolean, text: string): Promise<boolean> {
    const { store } = this.deps;
    if (r.ref) {
      const ref = r.ref.trim().toLowerCase();
      const triggers = await store.listTriggers(account.workspaceId, account.id, 'ref_link');
      const t = triggers.find((x) => String((x.config as { ref?: string }).ref ?? '').toLowerCase() === ref);
      if (t) {
        await this.fire(account, contact, t, created, text);
        return true;
      }
    }
    if (r.adId || r.source === 'ADS') {
      const triggers = await store.listTriggers(account.workspaceId, account.id, 'ad_click');
      const adOf = (x: Trigger) => (x.config as { ad_id?: string | null }).ad_id;
      const t = triggers.find((x) => r.adId && adOf(x) === r.adId) ?? triggers.find((x) => !adOf(x)); // anúncio específico vence "qualquer"
      if (t) {
        await this.fire(account, contact, t, created, text);
        return true;
      }
    }
    return false;
  }

  /** Cliques em botões / respostas rápidas / ice breakers. Retorna true se tratou. */
  private async onPayload(account: Account, contact: Contact, raw: string, created: boolean, text: string): Promise<boolean> {
    const { store } = this.deps;
    const p = parsePayload(raw);

    if (p.type === 'trigger') {
      const t = await store.getTrigger(p.triggerId);
      if (!t || t.workspaceId !== account.workspaceId) return false;
      await this.fire(account, contact, t, created, text);
      return true;
    }

    // Sugestão tocada numa Pergunta: vale como resposta digitada (segue o caminho normal da DM)
    if (p.type === 'answer') return false;

    // "Pular" da Pergunta: segue sem salvar
    if (p.type === 'skip') {
      const active = await store.getActiveSession(contact.id);
      if (!active || active.status !== 'waiting_input' || active.flowVersionId !== p.versionId || active.currentNodeId !== p.nodeId) return true;
      const version = await store.getFlowVersion(p.versionId);
      const node = version?.graph.nodes[p.nodeId];
      if (node?.type !== 'ask') return true;
      delete active.vars.__retries;
      await this.continueSession(account, contact, active, node.next ?? null, { lastText: text });
      return true;
    }

    if (p.type === 'custom') {
      const triggers = await store.listTriggers(account.workspaceId, account.id, 'postback');
      const t = triggers.find((x) => (x.config as { payload?: string }).payload === p.payload);
      if (!t) return false;
      await this.fire(account, contact, t, created, text);
      return true;
    }

    const version = await store.getFlowVersion(p.versionId);
    if (!version) return false;
    const node = version.graph.nodes[p.nodeId];
    if (!node) return false;

    // Botão 🔒 (ou bloco "Só seguidores"): volta ao nó, que agora consegue conferir se segue (a pessoa interagiu)
    if (p.type === 'gate' || p.type === 'lock') {
      if (p.type === 'gate' ? node.type !== 'follow_gate' : node.type !== 'message' || !node.data.buttons?.[p.index]) return false;
      const flag = p.type === 'gate' ? { __gate: p.nodeId } : { __lock: { node: p.nodeId, i: p.index, retry: p.retry } };
      await store.logEvent({
        workspaceId: account.workspaceId,
        contactId: contact.id,
        flowId: version.flowId,
        nodeId: p.nodeId,
        type: p.type === 'gate' ? 'gate_clicked' : 'button_clicked',
        data: p.type === 'lock' ? { index: p.index, locked: true } : undefined,
      });
      const active = await store.getActiveSession(contact.id);
      if (active && active.flowVersionId === version.id) {
        Object.assign(active.vars, flag);
        await this.continueSession(account, contact, active, p.nodeId, { lastText: text });
      } else {
        await store.cancelActiveSessions(contact.id);
        const session = await store.createSession({
          workspaceId: account.workspaceId,
          contactId: contact.id,
          flowId: version.flowId,
          flowVersionId: version.id,
          status: 'running',
          currentNodeId: p.nodeId,
          vars: { __last_text: text, __new: created, ...flag },
          waitToken: null,
        });
        await this.run(this.makeCtx(account, contact, session, version), p.nodeId, 0);
      }
      return true;
    }

    let target: string | null | undefined;
    if (p.type === 'button' && node.type === 'message') target = node.data.buttons?.[p.index]?.next;
    if (p.type === 'quick_reply' && node.type === 'message') target = node.data.quick_replies?.[p.index]?.next;
    if (p.type === 'card_button' && node.type === 'carousel') target = node.data.cards[p.card]?.buttons?.[p.index]?.next;

    // "Salvar a opção no campo": guarda o texto do botão/resposta tocada
    if (node.type === 'message' && node.data.save_to && (p.type === 'button' || p.type === 'quick_reply')) {
      const label = (p.type === 'button' ? node.data.buttons?.[p.index] : node.data.quick_replies?.[p.index])?.label;
      if (label) await store.setField(contact.id, node.data.save_to, label);
    }
    // Ações do próprio botão (tag, campo, atendente)
    const tapped =
      p.type === 'button' && node.type === 'message'
        ? node.data.buttons?.[p.index]
        : p.type === 'quick_reply' && node.type === 'message'
          ? node.data.quick_replies?.[p.index]
          : p.type === 'card_button' && node.type === 'carousel'
            ? node.data.cards[p.card]?.buttons?.[p.index]
            : undefined;
    if (tapped?.actions?.length) await applyButtonActions(store, account.workspaceId, contact, tapped.actions, this.now(), account.settings.bot_pause_hours);

    await store.logEvent({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      flowId: version.flowId,
      nodeId: p.nodeId,
      type: 'button_clicked',
      data: { index: p.index, target },
    });
    if (!target) return true;

    const active = await store.getActiveSession(contact.id);
    if (active && active.flowVersionId === version.id) {
      await this.continueSession(account, contact, active, target, { lastText: text });
    } else {
      await store.cancelActiveSessions(contact.id);
      const session = await store.createSession({
        workspaceId: account.workspaceId,
        contactId: contact.id,
        flowId: version.flowId,
        flowVersionId: version.id,
        status: 'running',
        currentNodeId: target,
        vars: { __last_text: text, __new: created },
        waitToken: null,
      });
      await this.run(this.makeCtx(account, contact, session, version), target, 0);
    }
    return true;
  }

  private async fire(account: Account, contact: Contact, t: Trigger, created: boolean, text: string) {
    await this.deps.store.recordFire(t.id, contact.id, this.now());
    await this.startFlow(account, contact, t.flowId, { trigger: t, isNewContact: created, lastText: text });
  }

  // ─────────────────────────── Sessões ───────────────────────────

  async startFlow(
    account: Account,
    contact: Contact,
    flowId: string,
    opts: { trigger?: Trigger; isNewContact?: boolean; privateReplyCommentId?: string; lastText?: string; steps?: number } = {},
  ): Promise<void> {
    const { store } = this.deps;
    const version = await store.getPublishedVersion(flowId);
    if (!version) {
      this.deps.log?.warn({ flowId }, 'Fluxo sem versão publicada');
      return;
    }
    await store.cancelActiveSessions(contact.id);
    const session = await store.createSession({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      flowId,
      flowVersionId: version.id,
      status: 'running',
      currentNodeId: version.graph.start,
      vars: { __last_text: opts.lastText ?? '', __new: Boolean(opts.isNewContact), __trigger: opts.trigger?.id },
      waitToken: null,
    });
    await store.logEvent({
      workspaceId: account.workspaceId,
      contactId: contact.id,
      flowId,
      sessionId: session.id,
      type: 'flow_started',
      data: { trigger_id: opts.trigger?.id, trigger_type: opts.trigger?.type },
    });
    const ctx = this.makeCtx(account, contact, session, version, opts.privateReplyCommentId);
    await this.run(ctx, version.graph.start, opts.steps ?? 0);
  }

  private async continueSession(
    account: Account,
    contact: Contact,
    session: Session,
    nodeId: string | null,
    opts: { lastText?: string } = {},
  ) {
    const version = await this.deps.store.getFlowVersion(session.flowVersionId);
    if (!version) return;
    if (opts.lastText !== undefined) session.vars.__last_text = opts.lastText;
    session.status = 'running';
    session.waitToken = null;
    await this.deps.store.updateSession(session.id, { status: 'running', waitToken: null, vars: session.vars });
    await this.run(this.makeCtx(account, contact, session, version), nodeId, 0);
  }

  /** Resposta a um nó "ask". */
  private async onAnswer(account: Account, contact: Contact, session: Session, text: string) {
    const version = await this.deps.store.getFlowVersion(session.flowVersionId);
    const node = version?.graph.nodes[session.currentNodeId ?? ''];
    if (!version || !node || node.type !== 'ask') {
      return this.continueSession(account, contact, session, null);
    }
    const ctx = this.makeCtx(account, contact, session, version);
    session.vars.__last_text = text;
    const value = validateAnswer(text, node.data.validate);

    if (value !== null) {
      await this.deps.store.setField(contact.id, node.data.save_to, value);
      delete session.vars.__retries;
      return this.continueSession(account, contact, session, node.next ?? null);
    }

    const retries = Number(session.vars.__retries ?? 0) + 1;
    if (retries > node.data.max_retries) {
      delete session.vars.__retries;
      return this.continueSession(account, contact, session, node.data.on_invalid ?? null);
    }
    session.vars.__retries = retries;
    await this.deps.store.updateSession(session.id, { vars: session.vars });
    try {
      await ctx.send({ kind: 'text', text: node.data.retry_text ?? defaultRetryText(node.data.validate) }, session.currentNodeId!);
    } catch (err) {
      await this.handleSendError(ctx, session.currentNodeId!, err);
    }
  }

  /** Jobs agendados: atrasos, timeout de pergunta, retomada após estouro de cota. */
  async handleScheduled(job: ScheduledJob): Promise<void> {
    const { store } = this.deps;
    const session = await store.getSession(job.sessionId);
    if (!session || ('waitToken' in job && session.waitToken !== job.waitToken)) return; // job antigo/cancelado
    const contact = await store.getContact(session.contactId);
    const account = contact ? await store.getAccountById(contact.igAccountId) : null;
    if (!contact || !account || account.status !== 'active') return;
    if (this.isPaused(contact)) return;

    if (job.kind === 'resume_delay' || job.kind === 'resume_quota') {
      if (session.status !== 'waiting_delay') return;
      return this.continueSession(account, contact, session, job.nodeId);
    }
    if (job.kind === 'payment_update') {
      if (session.status !== 'waiting_payment' || session.vars.__payment_id !== job.paymentId) return;
      const status = (await this.deps.payments?.refresh(job.paymentId)) ?? 'pending';
      if (status === 'pending') return;
      const version = await store.getFlowVersion(session.flowVersionId);
      const node = version?.graph.nodes[session.currentNodeId ?? ''];
      if (node?.type !== 'charge') return;
      session.vars.payment_status = status;
      await store.logEvent({
        workspaceId: session.workspaceId,
        contactId: session.contactId,
        flowId: session.flowId,
        sessionId: session.id,
        nodeId: session.currentNodeId,
        type: status === 'paid' ? 'payment_paid' : 'payment_expired',
        data: { payment_id: job.paymentId },
      });
      return this.continueSession(account, contact, session, status === 'paid' ? (node.next ?? null) : (node.data.on_expired ?? null));
    }
    if (job.kind === 'ask_reminder') {
      if (session.status !== 'waiting_input') return;
      const version = await store.getFlowVersion(session.flowVersionId);
      const node = version?.graph.nodes[session.currentNodeId ?? ''];
      if (!version || node?.type !== 'ask') return;
      const ctx = this.makeCtx(account, contact, session, version);
      try {
        await ctx.send({ kind: 'text', text: node.data.reminder_text || `Ainda está aí? 😊 ${node.data.text}` }, session.currentNodeId!);
      } catch {
        /* janela fechada etc.: o lembrete é só um extra */
      }
      return;
    }
    if (job.kind === 'ask_timeout') {
      if (session.status !== 'waiting_input') return;
      const version = await store.getFlowVersion(session.flowVersionId);
      const node = version?.graph.nodes[session.currentNodeId ?? ''];
      const target = node?.type === 'ask' ? (node.data.on_timeout ?? null) : null;
      return this.continueSession(account, contact, session, target);
    }
  }

  // ─────────────────────────── Execução ───────────────────────────

  private makeCtx(
    account: Account,
    contact: Contact,
    session: Session,
    version: FlowVersion,
    privateReplyCommentId?: string,
  ): RunContext {
    const deps = this.deps;
    const ctx: RunContext = {
      deps,
      account,
      contact,
      session,
      version,
      graph: version.graph,
      privateReplyCommentId,
      now: () => this.now(),
      send: async (msg, nodeId) => {
        let recipient: Recipient;
        if (ctx.privateReplyCommentId) {
          recipient = { comment_id: ctx.privateReplyCommentId };
        } else {
          const last = ctx.contact.lastInboundAt?.getTime() ?? 0;
          if (this.now().getTime() - last > WINDOW_MS) throw new WindowClosedError();
          recipient = { id: ctx.contact.igsid };
        }
        if (!(await deps.consumeQuota(account.id, account.hourlySendLimit))) throw new QuotaExceededError();

        const token = await deps.store.getAccessToken(account.id);
        const res = await deps.ig.sendMessage(token, account.pageId ?? account.igUserId, recipient, msg);
        ctx.privateReplyCommentId = undefined; // resposta privada só pode ser usada uma vez

        await deps.store.logMessage({
          workspaceId: account.workspaceId,
          contactId: ctx.contact.id,
          direction: 'out',
          source: 'bot',
          mid: res.messageId ?? null,
          text: 'text' in msg ? msg.text : null,
          payload: msg,
          sessionId: session.id,
        });
        await deps.store.logEvent({
          workspaceId: account.workspaceId,
          contactId: ctx.contact.id,
          flowId: session.flowId,
          sessionId: session.id,
          nodeId,
          type: 'message_sent',
        });
      },
    };
    return ctx;
  }

  private async run(ctx: RunContext, startNodeId: string | null | undefined, steps: number): Promise<void> {
    const { store } = this.deps;
    const { session } = ctx;
    let nodeId = startNodeId ?? null;

    while (nodeId) {
      if (++steps > MAX_STEPS) {
        this.deps.log?.warn({ sessionId: session.id }, 'Limite de passos atingido (possível loop)');
        await this.finish(ctx, 'failed', { reason: 'max_steps' });
        return;
      }
      const node: FlowNode | undefined = ctx.graph.nodes[nodeId];
      if (!node) {
        await this.finish(ctx, 'failed', { reason: 'node_not_found', nodeId });
        return;
      }

      session.currentNodeId = nodeId;
      await store.logEvent({
        workspaceId: session.workspaceId,
        contactId: session.contactId,
        flowId: session.flowId,
        sessionId: session.id,
        nodeId,
        type: 'node_executed',
        data: { type: node.type },
      });

      let result: NodeResult;
      try {
        result = await executeNode(ctx, nodeId, node);
      } catch (err) {
        await this.handleSendError(ctx, nodeId, err);
        return;
      }

      switch (result.type) {
        case 'next':
          nodeId = result.next ?? null;
          continue;
        case 'wait_input': {
          const waitToken = randomUUID();
          await store.updateSession(session.id, { status: 'waiting_input', currentNodeId: nodeId, vars: session.vars, waitToken });
          if (result.timeoutMs) await this.deps.scheduler.schedule({ kind: 'ask_timeout', sessionId: session.id, waitToken }, result.timeoutMs);
          if (result.reminderMs && (!result.timeoutMs || result.reminderMs < result.timeoutMs))
            await this.deps.scheduler.schedule({ kind: 'ask_reminder', sessionId: session.id, waitToken }, result.reminderMs);
          return;
        }
        case 'wait_delay': {
          if (!result.next) break; // atraso no fim do fluxo = fim
          const waitToken = randomUUID();
          await store.updateSession(session.id, { status: 'waiting_delay', currentNodeId: nodeId, vars: session.vars, waitToken });
          await this.deps.scheduler.schedule(
            { kind: 'resume_delay', sessionId: session.id, waitToken, nodeId: result.next },
            result.delayMs,
          );
          return;
        }
        case 'wait_payment': {
          await store.updateSession(session.id, { status: 'waiting_payment', currentNodeId: nodeId, vars: session.vars, waitToken: randomUUID() });
          return;
        }
        case 'goto_flow': {
          await this.finish(ctx, 'completed', { goto: result.flowId });
          await this.startFlow(ctx.account, ctx.contact, result.flowId, { steps });
          return;
        }
        case 'end':
          break;
      }
      break;
    }
    await this.finish(ctx, 'completed');
  }

  private async finish(ctx: RunContext, status: 'completed' | 'failed', data?: unknown) {
    const { session } = ctx;
    session.status = status;
    await this.deps.store.updateSession(session.id, { status, vars: session.vars, waitToken: null });
    await this.deps.store.logEvent({
      workspaceId: session.workspaceId,
      contactId: session.contactId,
      flowId: session.flowId,
      sessionId: session.id,
      nodeId: session.currentNodeId,
      type: status === 'completed' ? 'flow_completed' : 'flow_failed',
      data,
    });
  }

  private async handleSendError(ctx: RunContext, nodeId: string, err: unknown) {
    const { store } = this.deps;
    const { session } = ctx;

    if (err instanceof WindowClosedError || (err instanceof IgApiError && err.isWindowError)) {
      // Fica parado neste nó até o cliente mandar mensagem
      await store.updateSession(session.id, { status: 'waiting_window', currentNodeId: nodeId, vars: session.vars, waitToken: null });
      return;
    }
    if (err instanceof QuotaExceededError || (err instanceof IgApiError && err.isRateLimit)) {
      const waitToken = randomUUID();
      const msToNextHour = 3_600_000 - (this.now().getTime() % 3_600_000) + Math.floor(Math.random() * 60_000);
      await store.updateSession(session.id, { status: 'waiting_delay', currentNodeId: nodeId, vars: session.vars, waitToken });
      await this.deps.scheduler.schedule({ kind: 'resume_quota', sessionId: session.id, waitToken, nodeId }, msToNextHour);
      return;
    }
    if (err instanceof IgApiError && err.isAuthError) {
      await store.markAccountStatus(ctx.account.id, 'token_expired');
    }
    this.deps.log?.error({ err, sessionId: session.id, nodeId }, 'Erro ao executar nó');
    await store.logEvent({
      workspaceId: session.workspaceId,
      contactId: session.contactId,
      flowId: session.flowId,
      sessionId: session.id,
      nodeId,
      type: 'send_failed',
      data: { message: err instanceof Error ? err.message : String(err) },
    });
    await this.finish(ctx, 'failed', { nodeId });
  }
}

// ─────────────────────────── Validação de respostas ───────────────────────────

export function validateAnswer(text: string, type: 'text' | 'email' | 'phone' | 'number'): string | number | null {
  const t = text.trim();
  if (!t) return null;
  switch (type) {
    case 'text':
      return t;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? t.toLowerCase() : null;
    case 'phone': {
      const digits = t.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 13 ? digits : null;
    }
    case 'number': {
      const n = Number(t.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) && /\d/.test(t) ? n : null;
    }
  }
}

function defaultRetryText(type: string): string {
  switch (type) {
    case 'email':
      return 'Hmm, não parece um e-mail válido. Pode enviar de novo?';
    case 'phone':
      return 'Não consegui entender o telefone. Envie com DDD, por favor (ex.: 31999998888).';
    case 'number':
      return 'Pode enviar só o número, por favor?';
    default:
      return 'Não entendi, pode repetir?';
  }
}

/** Ações simples de botão (tag, campo, atendente) — também usadas no clique de link rastreado. */
export async function applyButtonActions(
  store: EngineDeps['store'],
  workspaceId: string,
  contact: Contact,
  actions: ButtonAction[],
  now: Date,
  pauseHours = 12,
) {
  for (const a of actions) {
    if (a.type === 'add_tag') await store.addTag(workspaceId, contact.id, a.tag);
    else if (a.type === 'remove_tag') await store.removeTag(workspaceId, contact.id, a.tag);
    else if (a.type === 'set_field') await store.setField(contact.id, a.field, a.value);
    else if (a.type === 'human_handoff') {
      const until = new Date(now.getTime() + pauseHours * 3_600_000);
      await store.updateContact(contact.id, { botPausedUntil: until });
      await store.logEvent({ workspaceId, contactId: contact.id, type: 'human_handoff', data: { via: 'button' } });
    }
  }
}
