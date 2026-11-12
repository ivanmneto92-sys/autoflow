/** Formato das publicações agendadas (compartilhado entre API e worker). */
import { z } from 'zod';

export const MEDIA_TYPES = ['IMAGE', 'REELS', 'CAROUSEL'] as const;
export const CAROUSEL_MAX = 10;
export type MediaType = (typeof MEDIA_TYPES)[number];
export type PostStatus = 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export const MediaItemSchema = z.object({
  url: z.string().url(),
  kind: z.enum(['image', 'video']),
  // Reels: quadro do vídeo usado como capa, em milissegundos desde o início (vai para a Meta como thumb_offset)
  thumb_offset_ms: z.number().int().min(0).max(15 * 60 * 1000).optional(),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

/** Gatilho de comentário criado automaticamente quando o post é publicado. */
export const AutomationSchema = z.object({
  flow_id: z.string().uuid(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]), // vazio = qualquer comentário
  match: z.enum(['exact', 'contains', 'starts_with']).default('contains'),
  public_replies: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  once_per_contact: z.boolean().default(false),
});
export type Automation = z.infer<typeof AutomationSchema>;

export const PostInputSchema = z.object({
  ig_account_id: z.string().uuid(),
  media_type: z.enum(MEDIA_TYPES),
  media: z.array(MediaItemSchema).min(1).max(CAROUSEL_MAX),
  caption: z.string().max(2200).default(''),
  scheduled_at: z.string().datetime({ offset: true }).nullable().default(null), // null = publicar agora
  automation: AutomationSchema.nullable().default(null),
});
export type PostInput = z.infer<typeof PostInputSchema>;

/** Regras do Instagram que dá para conferir antes de mandar para a Meta. Devolve a mensagem de erro ou null. */
export function checkPostRules(input: PostInput): string | null {
  const item = input.media[0]!;
  if (input.media_type === 'CAROUSEL') {
    if (input.media.length < 2) return 'O carrossel precisa de pelo menos 2 fotos ou vídeos';
  } else {
    if (input.media.length !== 1) return 'Envie um arquivo só (para várias fotos, escolha Carrossel)';
    if (input.media_type === 'IMAGE' && item.kind !== 'image') return 'Publicação de imagem precisa de um arquivo de imagem';
    if (input.media_type === 'REELS' && item.kind !== 'video') return 'Reels precisa de um arquivo de vídeo';
  }
  const hashtags = input.caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtags > 30) return `A legenda tem ${hashtags} hashtags — o Instagram aceita no máximo 30`;
  const mentions = input.caption.match(/@[\w.]+/g)?.length ?? 0;
  if (mentions > 20) return `A legenda marca ${mentions} perfis — o Instagram aceita no máximo 20`;
  return null;
}
