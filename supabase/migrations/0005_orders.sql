-- Pedidos feitos pelo Direct (registrados pela ação "Registrar pedido" do fluxo)
create table if not exists autoflow.orders (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references autoflow.workspaces(id) on delete cascade,
  number         int not null,
  contact_id     uuid references autoflow.contacts(id) on delete set null,
  ig_account_id  uuid references autoflow.ig_accounts(id) on delete set null,
  flow_id        uuid references autoflow.flows(id) on delete set null,
  status         text not null default 'new'
                 check (status in ('new', 'preparing', 'delivering', 'done', 'cancelled')),
  summary        text not null default '',
  details        jsonb not null default '[]'::jsonb,   -- [{ label, value }]
  total_cents    int,
  payment_status text not null default 'none'
                 check (payment_status in ('none', 'pending', 'paid', 'expired', 'refunded')),
  payment        jsonb,                                -- dados do Pix (Mercado Pago / Asaas)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, number)
);
create index if not exists orders_ws_idx on autoflow.orders (workspace_id, created_at desc);
create index if not exists orders_status_idx on autoflow.orders (workspace_id, status);

alter table autoflow.orders enable row level security;
drop policy if exists member_all on autoflow.orders;
create policy member_all on autoflow.orders for all
  using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id));
