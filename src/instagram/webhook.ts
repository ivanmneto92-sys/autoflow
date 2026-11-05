/**
 * Verificação de assinatura e normalização dos webhooks do Instagram para um formato interno.
 */
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacSha256Hex(appSecret, rawBody));
}

export type InboundEvent =
  | {
      kind: 'dm';
      igUserId: string; // conta do negócio
      senderId: string; // IGSID do cliente
      mid: string;
      text: string;
      quickReplyPayload?: string;
      attachments?: { type: string; url?: string }[];
      /** Resposta a um story da conta */
      storyReply?: { id?: string; url?: string };
      /** Primeira mensagem vinda de anúncio ou link ig.me com ref */
      referral?: Referral;
      timestamp: number;
    }
  | {
      /** Clique num link ig.me com ref numa conversa que já existe */
      kind: 'referral';
      igUserId: string;
      senderId: string;
      mid: string;
      referral: Referral;
      timestamp: number;
    }
  | {
      kind: 'postback';
      igUserId: string;
      senderId: string;
      mid: string;
      title?: string;
      payload: string;
      timestamp: number;
    }
  | {
      kind: 'story_mention';
      igUserId: string;
      senderId: string;
      mid: string;
      url?: string;
      timestamp: number;
    }
  | {
      kind: 'comment';
      igUserId: string;
      commentId: string;
      text: string;
      fromId: string;
      fromUsername?: string;
      mediaId?: string;
      mediaProductType?: string;
      parentId?: string;
      timestamp: number;
    }
  | {
      /** Mensagem enviada PELA conta (pelo nosso bot ou por um humano no app do Instagram) */
      kind: 'echo';
      igUserId: string;
      recipientId: string;
      mid: string;
      text?: string;
      timestamp: number;
    };

export interface Referral {
  ref?: string;
  source?: string; // ADS, IGME_SOURCE_LINK…
  adId?: string;
}

function toReferral(r: RawReferral | undefined): Referral | undefined {
  if (!r || (!r.ref && !r.ad_id && !r.source)) return undefined;
  return { ref: r.ref ?? undefined, source: r.source ?? undefined, adId: r.ad_id != null ? String(r.ad_id) : undefined };
}

export function dedupeKey(e: InboundEvent): string {
  switch (e.kind) {
    case 'comment':
      return `comment:${e.commentId}`;
    case 'postback':
      return `postback:${e.mid}:${e.payload}`;
    default:
      return `${e.kind}:${e.mid}`;
  }
}

interface RawReferral {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string | number;
}

interface RawMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    quick_reply?: { payload: string };
    attachments?: { type: string; payload?: { url?: string } }[];
    reply_to?: { mid?: string; story?: { id?: string; url?: string } };
    referral?: RawReferral;
  };
  postback?: { mid: string; title?: string; payload: string };
  referral?: RawReferral;
  read?: unknown;
  reaction?: unknown;
}

interface RawChange {
  field: string;
  value: {
    id?: string;
    text?: string;
    from?: { id: string; username?: string };
    media?: { id: string; media_product_type?: string };
    parent_id?: string;
  };
}

export function normalizeWebhook(body: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  const b = body as { object?: string; entry?: { id: string; time?: number; messaging?: RawMessaging[]; changes?: RawChange[] }[] };
  if (b?.object !== 'instagram' || !Array.isArray(b.entry)) return out;

  for (const entry of b.entry) {
    const igUserId = String(entry.id);

    for (const m of entry.messaging ?? []) {
      const ts = m.timestamp ?? Date.now();
      if (m.message) {
        const msg = m.message;
        if (msg.is_deleted || msg.is_unsupported) continue;
        if (msg.is_echo) {
          out.push({ kind: 'echo', igUserId, recipientId: m.recipient!.id, mid: msg.mid, text: msg.text, timestamp: ts });
          continue;
        }
        const storyMention = msg.attachments?.find((a) => a.type === 'story_mention');
        if (storyMention) {
          out.push({ kind: 'story_mention', igUserId, senderId: m.sender!.id, mid: msg.mid, url: storyMention.payload?.url, timestamp: ts });
          continue;
        }
        out.push({
          kind: 'dm',
          igUserId,
          senderId: m.sender!.id,
          mid: msg.mid,
          text: msg.text ?? '',
          quickReplyPayload: msg.quick_reply?.payload,
          attachments: msg.attachments?.map((a) => ({ type: a.type, url: a.payload?.url })),
          ...(msg.reply_to?.story ? { storyReply: { id: msg.reply_to.story.id, url: msg.reply_to.story.url } } : {}),
          ...(toReferral(msg.referral) ? { referral: toReferral(msg.referral) } : {}),
          timestamp: ts,
        });
      } else if (m.postback) {
        out.push({
          kind: 'postback',
          igUserId,
          senderId: m.sender!.id,
          mid: m.postback.mid,
          title: m.postback.title,
          payload: m.postback.payload,
          timestamp: ts,
        });
      } else if (m.referral && m.sender) {
        const referral = toReferral(m.referral);
        if (referral)
          out.push({ kind: 'referral', igUserId, senderId: m.sender.id, mid: `ref_${m.sender.id}_${ts}`, referral, timestamp: ts });
      }
    }

    for (const ch of entry.changes ?? []) {
      if (ch.field !== 'comments' || !ch.value?.id || !ch.value.from) continue;
      out.push({
        kind: 'comment',
        igUserId,
        commentId: ch.value.id,
        text: ch.value.text ?? '',
        fromId: ch.value.from.id,
        fromUsername: ch.value.from.username,
        mediaId: ch.value.media?.id,
        mediaProductType: ch.value.media?.media_product_type,
        parentId: ch.value.parent_id,
        timestamp: (entry.time ?? Math.floor(Date.now() / 1000)) * 1000,
      });
    }
  }
  return out;
}
