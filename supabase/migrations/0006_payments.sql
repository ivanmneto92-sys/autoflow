-- Cobrança por Pix (Mercado Pago / Asaas). Cada negócio conecta a própria conta.
create table if not exists autoflow.payment_accounts (
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  provider      text not null check (provider in ('mercadopago', 'asaas')),
  token_enc     text not null,                 -- chave da API, criptografada
  sandbox       boolean not null default false, -- Asaas: ambiente de testes
  webhook_token text not null,                 -- confere as notificações recebidas
  account_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table autoflow.payment_accounts enable row level security; -- sem política: só o backend acessa

create table if not exists autoflow.payments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references autoflow.workspaces(id) on delete cascade,
  contact_id   uuid references autoflow.contacts(id) on delete set null,
  session_id   uuid references autoflow.sessions(id) on delete set null,
  order_id     uuid references autoflow.orders(id) on delete set null,
  provider     text not null,
  provider_id  text not null,
  amount_cents int not null,
  description  text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  qr_code      text,
  ticket_url   text,
  expires_at   timestamptz not null,
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_id)
);
create index if not exists payments_pending_idx on autoflow.payments (created_at) where status = 'pending';
create index if not exists payments_ws_idx on autoflow.payments (workspace_id, created_at desc);
alter table autoflow.payments enable row level security;
drop policy if exists member_read on autoflow.payments;
create policy member_read on autoflow.payments for select using (autoflow.is_member(workspace_id));

-- Sessão esperando o Pix também é "ativa"
drop index if exists autoflow.sessions_active_idx;
create index if not exists sessions_active_idx
  on autoflow.sessions(contact_id) where status in ('running','waiting_input','waiting_delay','waiting_window','waiting_payment');
