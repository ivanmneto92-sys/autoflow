/** Tipos e rótulos das publicações agendadas (usados em Publicações, no editor de fluxo e em Gatilhos). */
export type MediaType = 'IMAGE' | 'REELS';
export type PostStatus = 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';
export type Match = 'contains' | 'exact' | 'starts_with';

export interface Automation {
  flow_id: string;
  keywords: string[];
  match: Match;
  public_replies: string[];
  once_per_contact: boolean;
}

export interface Post {
  id: string;
  ig_account_id: string;
  media_type: MediaType;
  media: { url: string; kind: 'image' | 'video' }[];
  caption: string;
  scheduled_at: string;
  status: PostStatus;
  automation: Automation | null;
  trigger_id: string | null;
  permalink: string | null;
  error: string | null;
  published_at: string | null;
  username: string;
  flow_name: string | null;
  flow_status: string | null;
}

export const POST_STATUS: Record<PostStatus, { label: string; cls: string }> = {
  scheduled: { label: 'Agendada', cls: 'badge-primary' },
  publishing: { label: 'Publicando…', cls: 'badge-warning' },
  published: { label: 'Publicada', cls: 'badge-success' },
  failed: { label: 'Com erro', cls: 'badge-danger' },
  cancelled: { label: 'Cancelada', cls: '' },
};

export const MATCH_LABEL: Record<Match, string> = { contains: 'contém', exact: 'é exatamente', starts_with: 'começa com' };

/** Ainda não saiu: dá para editar o post e a automação dele. */
export const isEditable = (p: Pick<Post, 'status'>) => p.status === 'scheduled' || p.status === 'failed' || p.status === 'cancelled';

export function describeAutomation(a: Automation): string {
  return a.keywords.length ? `Comentário ${MATCH_LABEL[a.match]} "${a.keywords.join('", "')}"` : 'Qualquer comentário';
}

/** Data que representa o post no calendário/listas. */
export const postDate = (p: Post) => new Date(p.status === 'published' && p.published_at ? p.published_at : p.scheduled_at);

export function postTitle(p: Post): string {
  const first = p.caption.split('\n')[0]?.trim();
  return first ? (first.length > 60 ? first.slice(0, 57) + '…' : first) : p.media_type === 'REELS' ? 'Reels sem legenda' : 'Post sem legenda';
}
