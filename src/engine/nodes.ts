/**
 * Handlers dos tipos de nó. Para criar um nó novo:
 *   1. adicione o schema em src/flow/schema.ts
 *   2. adicione um `case` aqui retornando um NodeResult
 */
import type { Condition, FlowAction, FlowNode } from '../flow/schema.js';
import { payload } from '../flow/schema.js';
import type { Button } from '../instagram/client.js';
import { isOpen } from '../lib/businessHours.js';
import { matchAny, normalize } from '../lib/text.js';
import { renderTemplate } from '../lib/template.js';
import type { RunContext } from './engine.js';

export type NodeResult =
  | { type: 'next'; next: string | null | undefined }
  | { type: 'wait_input'; timeoutMs?: number }
  | { type: 'wait_payment' }
  | { type: 'wait_delay'; delayMs: number; next: string | null | undefined }
  | { type: 'goto_flow'; flowId: string }
  | { type: 'end' };

async function render(ctx: RunContext, text: string): Promise<string> {
  const fields = await ctx.deps.store.getFields(ctx.contact.id);
  return renderTemplate(text, {
    contact: { first_name: ctx.contact.firstName, name: ctx.contact.name, username: ctx.contact.username },
    fields,
    vars: ctx.session.vars,
  });
}

/**
 * Links com variáveis. Em links de WhatsApp (…?text=) a mensagem inteira é montada e codificada;
 * nos demais, só os valores das variáveis são codificados.
 */
export async function renderUrl(ctx: RunContext, url: string): Promise<string> {
  url = url.replace(/\{\{\s*whatsapp\s*\}\}/g, ctx.account.settings.whatsapp ?? '');
  if (!url.includes('{{') && !/\s/.test(url)) return url;
  const m = /^(https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^?]*\?(?:[^#]*&)?text=)(.*)$/is.exec(url);
  if (m) {
    let text = m[2]!;
    try {
      text = decodeURIComponent(text);
    } catch {
      /* texto já cru */
    }
    return m[1] + encodeURIComponent(await render(ctx, text));
  }
  const fields = await ctx.deps.store.getFields(ctx.contact.id);
  return url.replace(/\{\{[^}]+\}\}/g, (token) =>
    encodeURIComponent(
      renderTemplate(token, {
        contact: { first_name: ctx.contact.firstName, name: ctx.contact.name, username: ctx.contact.username },
        fields,
        vars: ctx.session.vars,
      }),
    ),
  );
}

async function toButtons(
  ctx: RunContext,
  nodeId: string,
  buttons: { label: string; next?: string | null; url?: string }[],
  card?: number,
): Promise<Button[]> {
  const urls = await Promise.all(buttons.map((b) => (b.url ? renderUrl(ctx, b.url) : Promise.resolve(undefined))));
  return buttons.map((b, i) =>
    b.url
      ? { type: 'web_url', title: b.label, url: urls[i]! }
      : {
          type: 'postback',
          title: b.label,
          payload:
            card === undefined
              ? payload.button(ctx.version.id, nodeId, i)
              : payload.cardButton(ctx.version.id, nodeId, card, i),
        },
  );
}

export async function executeNode(ctx: RunContext, nodeId: string, node: FlowNode): Promise<NodeResult> {
  switch (node.type) {
    case 'message': {
      const text = await render(ctx, node.data.text);
      if (node.data.buttons?.length) {
        await ctx.send({ kind: 'buttons', text, buttons: await toButtons(ctx, nodeId, node.data.buttons) }, nodeId);
      } else if (node.data.quick_replies?.length) {
        await ctx.send(
          {
            kind: 'text',
            text,
            quickReplies: node.data.quick_replies.map((q, i) => ({
              title: q.label,
              payload: payload.quickReply(ctx.version.id, nodeId, i),
            })),
          },
          nodeId,
        );
      } else {
        await ctx.send({ kind: 'text', text }, nodeId);
      }
      // Botões continuam o fluxo pelo payload; `next` (se houver) segue imediatamente
      return { type: 'next', next: node.next };
    }

    case 'image':
      await ctx.send({ kind: 'image', url: node.data.url }, nodeId);
      return { type: 'next', next: node.next };

    case 'carousel': {
      const cards = await Promise.all(
        node.data.cards.map(async (c, ci) => ({
          title: await render(ctx, c.title),
          subtitle: c.subtitle ? await render(ctx, c.subtitle) : undefined,
          image_url: c.image_url,
          default_url: c.url,
          buttons: c.buttons?.length ? await toButtons(ctx, nodeId, c.buttons, ci) : undefined,
        })),
      );
      await ctx.send({ kind: 'carousel', cards }, nodeId);
      return { type: 'next', next: node.next };
    }

    case 'ask': {
      ctx.session.vars.__retries = 0;
      await ctx.send({ kind: 'text', text: await render(ctx, node.data.text) }, nodeId);
      return { type: 'wait_input', timeoutMs: node.data.timeout_minutes ? node.data.timeout_minutes * 60_000 : undefined };
    }

    case 'condition': {
      for (const rule of node.data.rules) {
        if (await evaluate(ctx, rule.when)) return { type: 'next', next: rule.next };
      }
      return { type: 'next', next: node.data.else };
    }

    case 'action': {
      for (const a of node.data.actions) await runAction(ctx, nodeId, a);
      return { type: 'next', next: node.next };
    }

    case 'delay':
      return { type: 'wait_delay', delayMs: Math.round(node.data.minutes * 60_000), next: node.next };

    case 'randomizer': {
      const total = node.data.branches.reduce((s, b) => s + b.weight, 0);
      let r = Math.random() * total;
      for (const b of node.data.branches) {
        r -= b.weight;
        if (r <= 0) return { type: 'next', next: b.next };
      }
      return { type: 'next', next: node.data.branches.at(-1)?.next };
    }

    case 'goto_flow':
      return { type: 'goto_flow', flowId: node.data.flow_id };

    case 'charge':
      return charge(ctx, nodeId, node);

    case 'end':
      return { type: 'end' };
  }
}

async function evaluate(ctx: RunContext, c: Condition): Promise<boolean> {
  const { store } = ctx.deps;
  switch (c.type) {
    case 'has_tag':
      return (await store.getTags(ctx.contact.id)).includes(c.tag);
    case 'field_exists': {
      const v = (await store.getFields(ctx.contact.id))[c.field];
      return v !== undefined && v !== null && v !== '';
    }
    case 'field_equals': {
      const v = (await store.getFields(ctx.contact.id))[c.field];
      return v !== undefined && normalize(String(v)) === normalize(c.value);
    }
    case 'var_equals': {
      const v = ctx.session.vars[c.var];
      return v !== undefined && normalize(String(v)) === normalize(c.value);
    }
    case 'business_hours':
      return isOpen(ctx.account.settings.business_hours, ctx.account.settings.timezone ?? 'America/Sao_Paulo', ctx.now());
    case 'is_new_contact':
      return Boolean(ctx.session.vars.__new);
    case 'is_follower': {
      try {
        const token = await store.getAccessToken(ctx.account.id);
        return await ctx.deps.ig.getFollowStatus(token, ctx.contact.igsid);
      } catch (err) {
        // Normalmente: a pessoa ainda não interagiu (só comentou). Trata como "não segue" e registra o motivo.
        await store.logEvent({
          workspaceId: ctx.account.workspaceId,
          contactId: ctx.contact.id,
          flowId: ctx.version.flowId,
          nodeId: ctx.session.currentNodeId ?? null,
          type: 'follow_check_failed',
          data: { message: (err as Error).message },
        });
        return false;
      }
    }
    case 'last_text_matches':
      return matchAny(String(ctx.session.vars.__last_text ?? ''), c.keywords, c.match);
  }
}

async function runAction(ctx: RunContext, nodeId: string, a: FlowAction): Promise<void> {
  const { store } = ctx.deps;
  const ws = ctx.account.workspaceId;
  switch (a.type) {
    case 'add_tag':
      return store.addTag(ws, ctx.contact.id, a.tag);
    case 'remove_tag':
      return store.removeTag(ws, ctx.contact.id, a.tag);
    case 'set_field':
      return store.setField(ctx.contact.id, a.field, await render(ctx, a.value));
    case 'set_var':
      ctx.session.vars[a.var] = await render(ctx, a.value);
      return;
    case 'create_order': {
      const fields = await store.getFields(ctx.contact.id);
      const details = a.fields
        .map((f) => ({ label: f, value: fields[f] === undefined || fields[f] === null ? '' : String(fields[f]) }))
        .filter((d) => d.value);
      const order = await store.createOrder({
        workspaceId: ws,
        contactId: ctx.contact.id,
        igAccountId: ctx.account.id,
        flowId: ctx.session.flowId,
        summary: await render(ctx, a.summary),
        details,
        totalCents: a.total ? parseMoney(await render(ctx, a.total)) : null,
      });
      ctx.session.vars.order_number = order.number;
      ctx.session.vars.order_id = order.id;
      await store.logEvent({
        workspaceId: ws,
        contactId: ctx.contact.id,
        flowId: ctx.session.flowId,
        sessionId: ctx.session.id,
        nodeId,
        type: 'order_created',
        data: { order_id: order.id, number: order.number },
      });
      return;
    }
    case 'give_coupon': {
      const r = await store.assignCoupon(ws, a.campaign_id, ctx.contact.id);
      const tz = ctx.account.settings.timezone ?? 'America/Sao_Paulo';
      // coupon_status: novo | ja_tinha | esgotado | indisponivel — use numa Condição para tratar cada caso
      ctx.session.vars.coupon_status = { new: 'novo', existing: 'ja_tinha', sold_out: 'esgotado', unavailable: 'indisponivel' }[r.status];
      if (r.status === 'new' || r.status === 'existing') {
        ctx.session.vars.coupon_code = r.code;
        ctx.session.vars.coupon_discount = r.discount;
        ctx.session.vars.coupon_expires = r.expiresAt ? r.expiresAt.toLocaleDateString('pt-BR', { timeZone: tz }) : '';
      } else {
        ctx.session.vars.coupon_code = '';
      }
      await store.logEvent({
        workspaceId: ws,
        contactId: ctx.contact.id,
        flowId: ctx.session.flowId,
        sessionId: ctx.session.id,
        nodeId,
        type: r.status === 'new' ? 'coupon_given' : r.status === 'existing' ? 'coupon_repeated' : 'coupon_unavailable',
        data: { campaign_id: a.campaign_id, status: r.status, ...('code' in r ? { code: r.code } : {}) },
      });
      return;
    }
    case 'human_handoff': {
      const hours = ctx.account.settings.bot_pause_hours ?? 12;
      const until = new Date(ctx.now().getTime() + hours * 3_600_000);
      await store.updateContact(ctx.contact.id, { botPausedUntil: until });
      ctx.contact.botPausedUntil = until;
      await store.logEvent({
        workspaceId: ws,
        contactId: ctx.contact.id,
        flowId: ctx.session.flowId,
        sessionId: ctx.session.id,
        nodeId,
        type: 'human_handoff',
        data: { notify_text: a.notify_text },
      });
      return;
    }
    case 'webhook': {
      const doFetch = ctx.deps.fetch ?? fetch;
      const body = {
        workspace_id: ws,
        session_id: ctx.session.id,
        flow_id: ctx.session.flowId,
        contact: {
          id: ctx.contact.id,
          igsid: ctx.contact.igsid,
          username: ctx.contact.username,
          name: ctx.contact.name,
          tags: await store.getTags(ctx.contact.id),
          fields: await store.getFields(ctx.contact.id),
        },
        vars: Object.fromEntries(Object.entries(ctx.session.vars).filter(([k]) => !k.startsWith('__'))),
      };
      try {
        const res = await doFetch(a.url, {
          method: a.method,
          headers: { 'Content-Type': 'application/json' },
          body: a.method === 'POST' ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(8000),
        });
        const json = (await res.json().catch(() => null)) as
          | { set_fields?: Record<string, unknown>; set_vars?: Record<string, unknown>; add_tags?: string[] }
          | null;
        if (json && typeof json === 'object') {
          for (const [k, v] of Object.entries(json.set_fields ?? {})) await store.setField(ctx.contact.id, k, v);
          for (const [k, v] of Object.entries(json.set_vars ?? {})) ctx.session.vars[k] = v;
          for (const t of json.add_tags ?? []) await store.addTag(ws, ctx.contact.id, t);
          if (a.save_response_to) ctx.session.vars[a.save_response_to] = json;
        }
        ctx.session.vars.__webhook_status = res.status;
      } catch (err) {
        ctx.session.vars.__webhook_status = 0;
        await store.logEvent({
          workspaceId: ws,
          contactId: ctx.contact.id,
          flowId: ctx.session.flowId,
          sessionId: ctx.session.id,
          nodeId,
          type: 'webhook_failed',
          data: { url: a.url, message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }
  }
}

/** "R$ 1.234,56" | "49,90" | "49.90" | "50" → centavos (null se não der para ler). */
export function parseMoney(v: string): number | null {
  const s = v.replace(/[^\d.,-]/g, '');
  if (!s) return null;
  let n: number;
  if (s.includes(',')) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ''));
  else n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');

/** Nó "Cobrar Pix": gera a cobrança, manda o código copia-e-cola e espera o pagamento. */
async function charge(ctx: RunContext, nodeId: string, node: Extract<FlowNode, { type: 'charge' }>): Promise<NodeResult> {
  const { store } = ctx.deps;
  const fail = async (reason: string): Promise<NodeResult> => {
    await store.logEvent({
      workspaceId: ctx.account.workspaceId,
      contactId: ctx.contact.id,
      flowId: ctx.session.flowId,
      sessionId: ctx.session.id,
      nodeId,
      type: 'charge_failed',
      data: { reason },
    });
    await ctx.send({ kind: 'text', text: 'Não consegui gerar o Pix agora 😕 Já avisei a equipe, alguém vai te ajudar por aqui.' }, nodeId);
    return { type: 'next', next: node.data.on_expired ?? null };
  };

  const amountCents = parseMoney(await render(ctx, node.data.amount));
  if (!amountCents || amountCents <= 0) return fail(`Valor inválido: "${node.data.amount}"`);
  if (!ctx.deps.payments) return fail('Pagamentos não configurados');

  const fields = await store.getFields(ctx.contact.id);
  let created: { paymentId: string; qrCode: string; ticketUrl?: string };
  try {
    created = await ctx.deps.payments.create({
      workspaceId: ctx.account.workspaceId,
      provider: node.data.provider,
      simulator: ctx.account.igUserId.startsWith('sim_'),
      amountCents,
      description: await render(ctx, node.data.description),
      expiresAt: new Date(ctx.now().getTime() + node.data.expires_minutes * 60_000),
      contact: {
        id: ctx.contact.id,
        name: (fields.nome as string | undefined) ?? ctx.contact.name,
        email: fields.email as string | undefined,
        cpf: node.data.cpf ? await render(ctx, node.data.cpf) : (fields.cpf as string | undefined),
      },
      sessionId: ctx.session.id,
      orderId: (ctx.session.vars.order_id as string | undefined) ?? null,
    });
  } catch (err) {
    return fail((err as Error).message);
  }

  ctx.session.vars.__payment_id = created.paymentId;
  ctx.session.vars.payment_amount = brl(amountCents);
  const text = `${await render(ctx, node.data.text)}\n\n💰 Valor: ${brl(amountCents)}`;
  if (created.ticketUrl) {
    await ctx.send({ kind: 'buttons', text, buttons: [{ type: 'web_url', title: 'Ver QR Code', url: created.ticketUrl }] }, nodeId);
  } else {
    await ctx.send({ kind: 'text', text }, nodeId);
  }
  await ctx.send({ kind: 'text', text: created.qrCode }, nodeId);
  return { type: 'wait_payment' };
}
