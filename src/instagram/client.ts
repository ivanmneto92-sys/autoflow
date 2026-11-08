/**
 * Cliente da Graph API do Instagram (envio de mensagens, respostas a comentários, perfil).
 * Docs: Instagram Platform → Instagram API with Instagram Login → Messaging / Comment moderation.
 */
import { config } from '../config.js';

export class IgApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
    public subcode?: number,
  ) {
    super(message);
  }
  /** Token inválido/expirado → reconectar conta */
  get isAuthError(): boolean {
    return this.code === 190 || this.status === 401;
  }
  /** Fora da janela de 24h ou usuário não pode receber */
  get isWindowError(): boolean {
    return this.code === 10 || this.subcode === 2534022 || this.subcode === 2018278;
  }
  get isRateLimit(): boolean {
    return this.code === 4 || this.code === 17 || this.code === 32 || this.code === 613 || this.status === 429;
  }
}

/** Destinatário: usuário (IGSID) ou comentário (resposta privada — só 1 mensagem por comentário). */
export type Recipient = { id: string } | { comment_id: string };

export interface QuickReply {
  title: string;
  payload: string;
}
export type Button = { type: 'postback'; title: string; payload: string } | { type: 'web_url'; title: string; url: string };
export interface CarouselCard {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_url?: string;
  buttons?: Button[];
}

export type OutMessage =
  | { kind: 'text'; text: string; quickReplies?: QuickReply[] }
  | { kind: 'buttons'; text: string; buttons: Button[] }
  | { kind: 'image'; url: string }
  | { kind: 'file'; url: string }
  | { kind: 'carousel'; cards: CarouselCard[] };

export interface IgClient {
  sendMessage(token: string, igUserId: string, to: Recipient, msg: OutMessage): Promise<{ messageId?: string }>;
  replyToComment(token: string, commentId: string, text: string): Promise<{ id?: string }>;
  getUserProfile(token: string, igsid: string): Promise<{ name?: string; username?: string }>;
  /** A pessoa segue a conta? Só funciona depois que ela mandou mensagem ou clicou num botão. */
  getFollowStatus(token: string, igsid: string): Promise<boolean>;
}

export function toGraphMessage(msg: OutMessage): Record<string, unknown> {
  switch (msg.kind) {
    case 'text':
      return {
        text: msg.text,
        ...(msg.quickReplies?.length
          ? {
              quick_replies: msg.quickReplies.slice(0, 13).map((q) => ({
                content_type: 'text',
                title: q.title.slice(0, 20),
                payload: q.payload,
              })),
            }
          : {}),
      };
    case 'buttons':
      return {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: msg.text.slice(0, 640),
            buttons: msg.buttons.slice(0, 3).map((b) => ({ ...b, title: b.title.slice(0, 20) })),
          },
        },
      };
    case 'image':
      return { attachment: { type: 'image', payload: { url: msg.url } } };
    case 'file':
      return { attachment: { type: 'file', payload: { url: msg.url } } };
    case 'carousel':
      return {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: msg.cards.slice(0, 10).map((c) => ({
              title: c.title.slice(0, 80),
              ...(c.subtitle ? { subtitle: c.subtitle.slice(0, 80) } : {}),
              ...(c.image_url ? { image_url: c.image_url } : {}),
              ...(c.default_url ? { default_action: { type: 'web_url', url: c.default_url } } : {}),
              ...(c.buttons?.length ? { buttons: c.buttons.slice(0, 3) } : {}),
            })),
          },
        },
      };
  }
}

/** Token das contas do simulador: nada sai para a Meta, as mensagens só ficam no banco. */
export const SIM_TOKEN = '__autoflow_simulator__';
/** No simulador, quem "segue" a conta (marcado na tela do simulador). */
export const simFollowers = new Set<string>();
let simSeq = 0;
const simId = (p: string) => `sim_${p}_${Date.now()}_${++simSeq}`;

export class GraphIgClient implements IgClient {
  private base =
    config().IG_LOGIN_MODE === 'facebook'
      ? `https://graph.facebook.com/${config().IG_GRAPH_VERSION}`
      : `https://graph.instagram.com/${config().IG_GRAPH_VERSION}`;

  private async call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    // Tokens do login do Instagram (IGAA…) só funcionam no graph.instagram.com
    const base = token.startsWith('IG') ? `https://graph.instagram.com/${config().IG_GRAPH_VERSION}` : this.base;
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message: string; code?: number; error_subcode?: number };
    } & T;
    if (!res.ok || body.error) {
      throw new IgApiError(
        body.error?.message ?? res.statusText,
        res.status,
        body.error?.code,
        body.error?.error_subcode,
      );
    }
    return body;
  }

  async sendMessage(token: string, igUserId: string, to: Recipient, msg: OutMessage) {
    if (token === SIM_TOKEN) return { messageId: simId('m') };
    // igUserId aqui é o "remetente": a Página (token de Página) ou a própria conta IG
    const path = `/${igUserId}/messages`;
    const body = await this.call<{ message_id?: string }>(token, path, {
      method: 'POST',
      body: JSON.stringify({ recipient: to, message: toGraphMessage(msg) }),
    });
    return { messageId: body.message_id };
  }

  async replyToComment(token: string, commentId: string, text: string) {
    if (token === SIM_TOKEN) return { id: simId('r') };
    return this.call<{ id?: string }>(token, `/${commentId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ message: text }),
    });
  }

  /** Dados de uma conta IG pelo ID (modo facebook, ex.: token de usuário do sistema). */
  async getIgAccount(token: string, igId: string) {
    return this.call<{ id: string; username: string; name?: string; profile_picture_url?: string }>(
      token,
      `/${igId}?fields=id,username,name,profile_picture_url`,
    );
  }

  /** Posts/reels recentes da conta (para escolher o post no gatilho de comentário). */
  async getMedia(token: string, igUserId: string, limit = 24) {
    return this.call<{
      data: { id: string; caption?: string; media_type: string; media_url?: string; thumbnail_url?: string; permalink: string; timestamp: string }[];
    }>(token, `/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=${limit}`);
  }

  async getUserProfile(token: string, igsid: string) {
    if (token === SIM_TOKEN) return { name: 'Cliente Teste', username: 'cliente.teste' };
    return this.call<{ name?: string; username?: string }>(token, `/${igsid}?fields=name,username`);
  }

  async getFollowStatus(token: string, igsid: string) {
    if (token === SIM_TOKEN) return simFollowers.has(igsid);
    const body = await this.call<{ is_user_follow_business?: boolean }>(token, `/${igsid}?fields=is_user_follow_business`, {
      signal: AbortSignal.timeout(15_000),
    });
    return body.is_user_follow_business === true;
  }

  /** Dados da conta conectada. `user_id` = ID usado nos webhooks (entry.id). */
  async getMe(token: string) {
    return this.call<{
      id: string;
      user_id: string;
      username: string;
      name?: string;
      account_type?: string;
      profile_picture_url?: string;
    }>(token, '/me?fields=id,user_id,username,name,account_type,profile_picture_url');
  }

  /** Inscreve a conta nos webhooks do app. */
  async subscribeWebhooks(token: string, fields = ['messages', 'messaging_postbacks', 'comments'], accountId = 'me') {
    return this.call<{ success: boolean }>(token, `/${accountId}/subscribed_apps?subscribed_fields=${fields.join(',')}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
  }

  // ── Publicação de conteúdo (Content Publishing API) ──
  // Passo 1: cria o contêiner (a Meta baixa a mídia da URL pública). Passo 2: publica o contêiner.

  private form(params: Record<string, string>): RequestInit {
    return {
      method: 'POST',
      body: new URLSearchParams(params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(60_000),
    };
  }

  async createMediaContainer(token: string, igUserId: string, params: Record<string, string>) {
    return this.call<{ id: string }>(token, `/${igUserId}/media`, this.form(params));
  }

  /** IN_PROGRESS → FINISHED (pronto) | ERROR | EXPIRED | PUBLISHED */
  async getContainerStatus(token: string, containerId: string) {
    return this.call<{ status_code?: string; status?: string }>(token, `/${containerId}?fields=status_code,status`, {
      signal: AbortSignal.timeout(20_000),
    });
  }

  async publishMedia(token: string, igUserId: string, creationId: string) {
    return this.call<{ id: string }>(token, `/${igUserId}/media_publish`, this.form({ creation_id: creationId }));
  }

  async getMediaInfo(token: string, mediaId: string) {
    return this.call<{ id: string; permalink?: string }>(token, `/${mediaId}?fields=id,permalink`, {
      signal: AbortSignal.timeout(20_000),
    });
  }

  /** Ice breakers (perguntas que aparecem na primeira conversa). */
  async setIceBreakers(token: string, items: { question: string; payload: string }[], locale = 'default') {
    return this.call<{ result: string }>(token, '/me/messenger_profile', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'instagram',
        ice_breakers: [{ locale, call_to_actions: items.slice(0, 4) }],
      }),
    });
  }
}
