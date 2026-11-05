-- Modo "login unificado" (Facebook): guarda a Página do Facebook ligada à conta do Instagram
alter table autoflow.ig_accounts add column if not exists page_id text;
