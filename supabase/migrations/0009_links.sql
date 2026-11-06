-- Links rastreados: cada botão de link vira PUBLIC_BASE_URL/r/<code> (um por contato), para contar cliques,
-- saber quem não clicou (lembrete) e rodar ações ao clicar (tag, campo).
create table if not exists autoflow.links (
  code             text primary key,
  workspace_id     uuid not null references autoflow.workspaces(id) on delete cascade,
  flow_id          uuid references autoflow.flows(id) on delete set null,
  node_id          text,
  contact_id       uuid references autoflow.contacts(id) on delete cascade,
  url              text not null,
  actions          jsonb,
  clicks           int not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at  timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists links_contact_flow_idx on autoflow.links (contact_id, flow_id);
create index if not exists links_flow_clicked_idx on autoflow.links (flow_id, first_clicked_at);

alter table autoflow.links enable row level security;
drop policy if exists member_all on autoflow.links;
create policy member_all on autoflow.links for all
  using (autoflow.is_member(workspace_id)) with check (autoflow.is_member(workspace_id));
