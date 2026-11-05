-- autoflow — schema inicial (MVP1, sem IA)
-- Tudo fica no schema "autoflow" para não colidir com outros apps no mesmo projeto Supabase.
-- Rodar via `npm run db:migrate` (ou no SQL Editor).

create schema if not exists autoflow;

-- ───────────────────────── Workspaces ─────────────────────────
create table if not exists autoflow.workspaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  plan          text not null default 'free',
  -- settings: { timezone, business_hours: { mon: [["11:00","23:00"]], ... }, bot_pause_hours }
  settings      jsonb not null default '{"timezone":"America/Sao_Paulo","bot_pause_hours":12}'::jsonb,
  created_at    timestamptz not null default now()
);

-- Membros (liga com auth.users do Supabase quando o painel existir)
create table if not exists autoflow.workspace_members (
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  user_id       uuid not null,
  role          text not null default 'owner',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ───────────────────────── Contas Instagram ─────────────────────────
create table if not exists autoflow.ig_accounts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references autoflow.workspaces(id) on delete cascade,
  ig_user_id         text not null unique,          -- ID da conta profissional (= entry.id dos webhooks)
  username           text,
  name               text,
  profile_picture_url text,
  account_type       text,
  status             text not null default 'active', -- active | token_expired | disconnected
  hourly_send_limit  int  not null default 190,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists ig_accounts_workspace_idx on autoflow.ig_accounts(workspace_id);

-- Tokens ficam numa tabela separada, sem política RLS (o painel nunca lê)
create table if not exists autoflow.ig_account_tokens (
  ig_account_id      uuid primary key references autoflow.ig_accounts(id) on delete cascade,
  access_token_enc   text not null,                 -- AES-256-GCM
  token_expires_at   timestamptz,
  refreshed_at       timestamptz not null default now()
);

-- ───────────────────────── Contatos ─────────────────────────
create table if not exists autoflow.contacts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references autoflow.workspaces(id) on delete cascade,
  ig_account_id      uuid not null references autoflow.ig_accounts(id) on delete cascade,
  igsid              text not null,                 -- Instagram-scoped ID do usuário
  username           text,
  name               text,
  first_name         text,
  last_inbound_at    timestamptz,                   -- controla a janela de 24h
  bot_paused_until   timestamptz,                   -- humano assumiu a conversa
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (ig_account_id, igsid)
);
create index if not exists contacts_workspace_idx on autoflow.contacts(workspace_id);

create table if not exists autoflow.tags (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  name          text not null,
  unique (workspace_id, name)
);

create table if not exists autoflow.contact_tags (
  contact_id    uuid not null references autoflow.contacts(id) on delete cascade,
  tag_id        uuid not null references autoflow.tags(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

-- Campos personalizados: valores ficam em jsonb por contato (simples e rápido)
create table if not exists autoflow.custom_fields (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  key           text not null,
  label         text not null,
  type          text not null default 'text',        -- text | number | email | phone
  unique (workspace_id, key)
);

create table if not exists autoflow.contact_fields (
  contact_id    uuid primary key references autoflow.contacts(id) on delete cascade,
  values        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- ───────────────────────── Fluxos ─────────────────────────
create table if not exists autoflow.flows (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references autoflow.workspaces(id) on delete cascade,
  name                  text not null,
  status                text not null default 'draft',   -- draft | published | archived
  draft_graph           jsonb,                           -- edição em andamento (painel)
  published_version_id  uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists flows_workspace_idx on autoflow.flows(workspace_id);

create table if not exists autoflow.flow_versions (
  id            uuid primary key default gen_random_uuid(),
  flow_id       uuid not null references autoflow.flows(id) on delete cascade,
  version       int  not null,
  graph         jsonb not null,                          -- imutável depois de criado
  created_at    timestamptz not null default now(),
  unique (flow_id, version)
);

alter table autoflow.flows
  drop constraint if exists flows_published_version_fk;
alter table autoflow.flows
  add constraint flows_published_version_fk
  foreign key (published_version_id) references autoflow.flow_versions(id) on delete set null;

-- ───────────────────────── Gatilhos ─────────────────────────
-- type: comment | dm_keyword | story_mention | postback | default_reply
-- config (exemplos):
--   comment:       { media_id?: string|null, keywords: string[], match: 'contains'|'exact'|'starts_with'|'any',
--                    public_replies?: string[], once_per_contact?: boolean }
--   dm_keyword:    { keywords: string[], match: 'contains'|'exact'|'starts_with' }
--   story_mention: {}
--   postback:      { payload: string }          -- ice breakers / menu persistente
--   default_reply: { cooldown_minutes?: number }
create table if not exists autoflow.triggers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  ig_account_id uuid references autoflow.ig_accounts(id) on delete cascade, -- null = todas as contas do workspace
  flow_id       uuid not null references autoflow.flows(id) on delete cascade,
  type          text not null,
  config        jsonb not null default '{}'::jsonb,
  priority      int  not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists triggers_lookup_idx on autoflow.triggers(workspace_id, type) where enabled;

-- Controle de "uma vez por contato" e cooldown
create table if not exists autoflow.trigger_fires (
  trigger_id    uuid not null references autoflow.triggers(id) on delete cascade,
  contact_id    uuid not null references autoflow.contacts(id) on delete cascade,
  last_fired_at timestamptz not null default now(),
  count         int not null default 1,
  primary key (trigger_id, contact_id)
);

-- ───────────────────────── Sessões (execução de fluxo) ─────────────────────────
-- status: running | waiting_input | waiting_delay | waiting_window | completed | failed | cancelled
create table if not exists autoflow.sessions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references autoflow.workspaces(id) on delete cascade,
  contact_id       uuid not null references autoflow.contacts(id) on delete cascade,
  flow_id          uuid not null references autoflow.flows(id) on delete cascade,
  flow_version_id  uuid not null references autoflow.flow_versions(id) on delete cascade,
  status           text not null default 'running',
  current_node_id  text,
  vars             jsonb not null default '{}'::jsonb,
  wait_token       text,          -- invalida timeouts/delays antigos
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  ended_at         timestamptz
);
create index if not exists sessions_active_idx
  on autoflow.sessions(contact_id) where status in ('running','waiting_input','waiting_delay','waiting_window');

-- ───────────────────────── Mensagens (inbox) ─────────────────────────
create table if not exists autoflow.messages (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  contact_id    uuid not null references autoflow.contacts(id) on delete cascade,
  direction     text not null,              -- in | out
  source        text not null,              -- user | bot | human | comment
  mid           text,                       -- id da mensagem na Meta
  text          text,
  payload       jsonb,
  session_id    uuid references autoflow.sessions(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists messages_contact_idx on autoflow.messages(contact_id, created_at desc);
create unique index if not exists messages_mid_idx on autoflow.messages(mid) where mid is not null;

-- ───────────────────────── Webhooks recebidos (dedupe + auditoria) ─────────────────────────
create table if not exists autoflow.webhook_events (
  id            bigserial primary key,
  dedupe_key    text not null unique,
  ig_user_id    text,
  kind          text,
  raw           jsonb not null,
  received_at   timestamptz not null default now()
);

-- ───────────────────────── Analytics ─────────────────────────
-- type: flow_started | node_executed | button_clicked | flow_completed | message_sent | send_failed
create table if not exists autoflow.events (
  id            bigserial primary key,
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  contact_id    uuid references autoflow.contacts(id) on delete set null,
  flow_id       uuid references autoflow.flows(id) on delete set null,
  session_id    uuid references autoflow.sessions(id) on delete set null,
  node_id       text,
  type          text not null,
  data          jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists events_flow_idx on autoflow.events(flow_id, type, created_at);

-- ───────────────────────── RLS ─────────────────────────
-- O backend usa a connection string (service role / postgres) e ignora RLS.
-- As políticas abaixo valem para o painel (usuário logado via Supabase Auth).
do $$
declare t text;
begin
  foreach t in array array['workspaces','workspace_members','ig_accounts','ig_account_tokens','contacts',
                           'tags','contact_tags','custom_fields','contact_fields','flows','flow_versions',
                           'triggers','trigger_fires','sessions','messages','webhook_events','events']
  loop
    execute format('alter table autoflow.%I enable row level security', t);
  end loop;
end $$;

create or replace function autoflow.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = autoflow, public as $$
  select exists (select 1 from autoflow.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

do $$
declare t text;
begin
  foreach t in array array['ig_accounts','contacts','tags','custom_fields',
                           'flows','triggers','sessions','messages','events']
  loop
    execute format('drop policy if exists member_all on autoflow.%I', t);
    execute format('create policy member_all on autoflow.%I for all using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id))', t);
  end loop;
end $$;

drop policy if exists member_read on autoflow.workspaces;
create policy member_read on autoflow.workspaces for select using (autoflow.is_member(id));

drop policy if exists own_membership on autoflow.workspace_members;
create policy own_membership on autoflow.workspace_members for select using (user_id = auth.uid());

-- Tabelas filhas sem workspace_id: acesso via contato/fluxo
drop policy if exists member_all on autoflow.contact_tags;
create policy member_all on autoflow.contact_tags for all
  using (exists (select 1 from autoflow.contacts c where c.id = contact_id and autoflow.is_member(c.workspace_id)));
drop policy if exists member_all on autoflow.contact_fields;
create policy member_all on autoflow.contact_fields for all
  using (exists (select 1 from autoflow.contacts c where c.id = contact_id and autoflow.is_member(c.workspace_id)));
drop policy if exists member_all on autoflow.flow_versions;
create policy member_all on autoflow.flow_versions for select
  using (exists (select 1 from autoflow.flows f where f.id = flow_id and autoflow.is_member(f.workspace_id)));

-- ig_account_tokens, trigger_fires e webhook_events: RLS ligado e SEM política = só o backend acessa.
