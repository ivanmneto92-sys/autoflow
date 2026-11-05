import { z } from 'zod';

const match = z.enum(['exact', 'contains', 'starts_with']).default('contains');

export const TriggerConfigSchemas = {
  comment: z.object({
    media_id: z.string().nullable().default(null), // null = qualquer post/reel
    keywords: z.array(z.string().min(1)).default([]), // vazio = qualquer comentário
    match,
    public_replies: z.array(z.string().min(1).max(300)).default([]), // sorteia uma
    once_per_contact: z.boolean().default(false),
  }),
  dm_keyword: z.object({ keywords: z.array(z.string().min(1)).min(1), match }),
  story_mention: z.object({}).default({}),
  // Resposta a um story da conta (vazio = qualquer resposta)
  story_reply: z.object({ keywords: z.array(z.string().min(1)).default([]), match }),
  // Link do Direct com ref: ig.me/m/<conta>?ref=<ref>
  ref_link: z.object({
    ref: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/, 'Use só letras, números, _ e -'),
  }),
  // Clique em anúncio "enviar mensagem" (Click-to-Direct). null = qualquer anúncio
  ad_click: z.object({ ad_id: z.string().trim().regex(/^\d+$/, 'ID do anúncio: só números').nullable().default(null) }),
  postback: z.object({ payload: z.string().min(1) }),
  default_reply: z.object({ cooldown_minutes: z.number().int().min(0).default(60) }),
} as const;

export const TriggerInputSchema = z.object({
  workspace_id: z.string().uuid(),
  flow_id: z.string().uuid(),
  ig_account_id: z.string().uuid().nullable().optional(),
  type: z.enum(['comment', 'dm_keyword', 'story_mention', 'story_reply', 'ref_link', 'ad_click', 'postback', 'default_reply']),
  config: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
});

export function parseTriggerConfig(type: keyof typeof TriggerConfigSchemas, config: unknown) {
  return TriggerConfigSchemas[type].parse(config ?? {});
}
