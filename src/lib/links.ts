/** Códigos curtos dos links rastreados (PUBLIC_BASE_URL/r/<code>). */
import { randomInt } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function linkCode(length = 9): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export const LINK_CODE_RE = /^[A-Za-z0-9]{2,16}$/;
