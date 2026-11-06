-- Cupons únicos: cada pessoa recebe um código só dela (gerado na hora ou tirado de uma lista importada)
create table if not exists autoflow.coupon_campaigns (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  name          text not null,
  discount      text not null default '',          -- ex.: "10% OFF", "Frete grátis"
  mode          text not null default 'generated' check (mode in ('generated', 'list')),
  prefix        text not null default '',          -- códigos gerados: PREFIXO-AB12CD
  valid_days    int check (valid_days is null or valid_days between 1 and 365),
  archived      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists coupon_campaigns_ws_idx on autoflow.coupon_campaigns (workspace_id, created_at desc);

create table if not exists autoflow.coupons (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references autoflow.workspaces(id) on delete cascade,
  campaign_id   uuid not null references autoflow.coupon_campaigns(id) on delete cascade,
  code          text not null,
  contact_id    uuid references autoflow.contacts(id) on delete set null,
  assigned_at   timestamptz,
  expires_at    timestamptz,
  redeemed_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, code)
);
-- Uma pessoa recebe no máximo um cupom por campanha
create unique index if not exists coupons_one_per_contact on autoflow.coupons (campaign_id, contact_id) where contact_id is not null;
-- Códigos da lista ainda livres (para pegar o próximo rápido)
create index if not exists coupons_free_idx on autoflow.coupons (campaign_id, created_at) where assigned_at is null;
create index if not exists coupons_campaign_idx on autoflow.coupons (campaign_id, assigned_at desc);

alter table autoflow.coupon_campaigns enable row level security;
drop policy if exists member_all on autoflow.coupon_campaigns;
create policy member_all on autoflow.coupon_campaigns for all
  using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id));

alter table autoflow.coupons enable row level security;
drop policy if exists member_all on autoflow.coupons;
create policy member_all on autoflow.coupons for all
  using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id));
