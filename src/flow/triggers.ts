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
  postback: z.object({ payload: z.string().min(1) }),
  default_reply: z.object({ cooldown_minutes: z.number().int().min(0).default(60) }),
} as const;

export const TriggerInputSchema = z.object({
  workspace_id: z.string().uuid(),
  flow_id: z.string().uuid(),
  ig_account_id: z.string().uuid().nullable().optional(),
  type: z.enum(['comment', 'dm_keyword', 'story_mention', 'postback', 'default_reply']),
  config: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
});

export function parseTriggerConfig(type: keyof typeof TriggerConfigSchemas, config: unknown) {
  return TriggerConfigSchemas[type].parse(config ?? {});
}
