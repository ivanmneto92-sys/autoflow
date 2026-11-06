/** Códigos de cupom: PREFIXO-XXXXXX, sem letras/números que se confundem (0/O, 1/I/L). */
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function normalizePrefix(p: string): string {
  return p
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export function generateCode(prefix: string, length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  const p = normalizePrefix(prefix);
  return p ? `${p}-${s}` : s;
}

/** Lista colada pelo usuário (uma por linha, vírgula ou espaço) → códigos únicos, sem vazios. */
export function parseCodeList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const c = raw.trim().slice(0, 60);
    if (!c || seen.has(c.toUpperCase())) continue;
    seen.add(c.toUpperCase());
    out.push(c);
  }
  return out;
}
