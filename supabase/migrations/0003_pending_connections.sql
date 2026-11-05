-- Tokens de logins que não acharam a conta do Instagram (para diagnóstico com scripts/probe-pending.ts)
create table if not exists autoflow.pending_connections (
  id            bigserial primary key,
  workspace_id  uuid references autoflow.workspaces(id) on delete cascade,
  token_enc     text not null,
  diag          jsonb,
  created_at    timestamptz not null default now()
);
alter table autoflow.pending_connections enable row level security;
