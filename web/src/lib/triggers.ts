/** Tipos de gatilho do painel (Gatilhos e o nó "Quando…" do editor de fluxo). */
export type TType = 'comment' | 'dm_keyword' | 'story_mention' | 'story_reply' | 'ref_link' | 'ad_click' | 'postback' | 'default_reply';

export interface Trigger {
  id: string;
  flow_id: string;
  flow_name: string;
  flow_status: string;
  ig_account_id: string | null;
  type: TType;
  config: any;
  priority: number;
  enabled: boolean;
}

/** Ordem em que aparecem para escolher. */
export const TYPES: Record<TType, { label: string; desc: string; icon: string }> = {
  dm_keyword: { label: 'Palavra-chave na DM', desc: 'Quando o cliente manda uma mensagem com certas palavras.', icon: '💬' },
  comment: { label: 'Comentário em post', desc: 'Quando alguém comenta — responde em público e chama no direct.', icon: '🗨' },
  story_reply: { label: 'Resposta ao story', desc: 'Quando alguém responde a um story da conta.', icon: '↩️' },
  story_mention: { label: 'Menção em story', desc: 'Quando alguém marca a conta num story.', icon: '📸' },
  ref_link: { label: 'Link do Direct (ig.me)', desc: 'Quando a pessoa abre o Direct por um link seu (bio, story, WhatsApp).', icon: '🔗' },
  ad_click: { label: 'Clique em anúncio', desc: 'Quando a pessoa chega pelo botão "Enviar mensagem" de um anúncio.', icon: '📣' },
  default_reply: { label: 'Resposta padrão', desc: 'Quando nenhuma outra regra entendeu a mensagem.', icon: '🤖' },
  postback: { label: 'Botão do menu / ice breaker', desc: 'Payload personalizado de botões do perfil.', icon: '🔘' },
};

export const MATCH: Record<string, string> = { contains: 'contém', exact: 'é exatamente', starts_with: 'começa com' };

export function describeTrigger(t: Pick<Trigger, 'type' | 'config'>): string {
  const c = t.config ?? {};
  const kws = (c.keywords ?? []) as string[];
  switch (t.type) {
    case 'dm_keyword':
      return `Mensagem ${MATCH[c.match] ?? 'contém'}: ${kws.join(', ')}`;
    case 'comment':
      return `${c.media_id ? 'Num post específico' : 'Em qualquer post'}${kws.length ? ` · comentário ${MATCH[c.match] ?? 'contém'}: ${kws.join(', ')}` : ' · qualquer comentário'}${c.once_per_contact ? ' · 1 vez por pessoa' : ''}`;
    case 'story_reply':
      return kws.length ? `Resposta ao story ${MATCH[c.match] ?? 'contém'}: ${kws.join(', ')}` : 'Qualquer resposta a story';
    case 'story_mention':
      return 'Quando marcarem a conta num story';
    case 'ref_link':
      return `Link ig.me com ref "${c.ref}"`;
    case 'ad_click':
      return c.ad_id ? `Anúncio ${c.ad_id}` : 'Qualquer anúncio de mensagem';
    case 'default_reply':
      return `No máximo 1 vez a cada ${c.cooldown_minutes} min por pessoa`;
    case 'postback':
      return `Payload: ${c.payload}`;
  }
}

export function triggerDefaults(type: TType): any {
  const defaults: Record<TType, any> = {
    dm_keyword: { keywords: [], match: 'contains' },
    comment: { media_id: null, keywords: [], match: 'contains', public_replies: ['Te chamei no direct! 📩'], once_per_contact: false },
    story_reply: { keywords: [], match: 'contains' },
    story_mention: {},
    ref_link: { ref: '' },
    ad_click: { ad_id: null },
    default_reply: { cooldown_minutes: 120 },
    postback: { payload: '' },
  };
  return structuredClone(defaults[type]);
}
