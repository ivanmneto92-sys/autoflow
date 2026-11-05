-- Publicações agendadas (imagem / Reels) com automação de comentários vinculada
create table if not exists autoflow.scheduled_posts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references autoflow.workspaces(id) on delete cascade,
  ig_account_id   uuid not null references autoflow.ig_accounts(id) on delete cascade,
  media_type      text not null check (media_type in ('IMAGE', 'REELS')),
  media           jsonb not null default '[]'::jsonb,       -- [{ url, kind: 'image' | 'video' }]
  caption         text not null default '',
  scheduled_at    timestamptz not null,
  status          text not null default 'scheduled'
                  check (status in ('scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  automation      jsonb,                                    -- gatilho de comentário criado ao publicar (ou null)
  trigger_id      uuid references autoflow.triggers(id) on delete set null,
  ig_container_id text,
  ig_media_id     text,
  permalink       text,
  error           text,
  attempts        int not null default 0,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);

create index if not exists scheduled_posts_due_idx
  on autoflow.scheduled_posts (scheduled_at) where status = 'scheduled';
create index if not exists scheduled_posts_ws_idx
  on autoflow.scheduled_posts (workspace_id, scheduled_at desc);

alter table autoflow.scheduled_posts enable row level security;
drop policy if exists member_all on autoflow.scheduled_posts;
create policy member_all on autoflow.scheduled_posts for all
  using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id));
