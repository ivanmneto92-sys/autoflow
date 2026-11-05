/**
 * Aplica as migrations de supabase/migrations em ordem (controle na tabela _af_migrations).
 * Num Postgres "puro" (local, sem Supabase) cria stubs de auth.uid() e dos papéis anon/authenticated.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import 'dotenv/config';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL');
const sql = postgres(url, { prepare: !url.includes(':6543'), onnotice: () => {} });

const [check] = await sql`select exists (select 1 from pg_namespace where nspname = 'auth') as has_auth`;
if (!check?.has_auth) {
  console.log('• Postgres local detectado: criando stubs do Supabase (auth.uid, anon, authenticated)');
  await sql.unsafe(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
}

await sql`create schema if not exists autoflow`;
await sql`create table if not exists autoflow._af_migrations (name text primary key, applied_at timestamptz not null default now())`;
const applied = new Set((await sql`select name from autoflow._af_migrations`).map((r) => r.name as string));

const dir = join(process.cwd(), 'supabase', 'migrations');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) continue;
  console.log(`• Aplicando ${file}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(dir, file), 'utf8'));
    await tx`insert into autoflow._af_migrations (name) values (${file})`;
  });
}
console.log('✓ Migrations em dia');
await sql.end();
