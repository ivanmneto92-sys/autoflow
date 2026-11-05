import postgres from 'postgres';
import { config } from '../config.js';

let sql: postgres.Sql | undefined;

export function db(): postgres.Sql {
  if (!sql) {
    sql = postgres(config().DATABASE_URL, {
      max: 10,
      // Supabase pooler (porta 6543, modo transaction) não suporta prepared statements
      prepare: !config().DATABASE_URL.includes(':6543'),
      transform: { undefined: null },
    });
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
}
