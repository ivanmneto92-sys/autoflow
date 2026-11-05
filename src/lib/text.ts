/** Normaliza texto para comparação: minúsculas, sem acento, sem pontuação, espaços únicos. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Tolerância a erro de digitação: 0 para palavras curtas, 1 a partir de 5 letras, 2 a partir de 9. */
function tolerance(word: string): number {
  if (word.length >= 9) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

function wordsMatch(a: string, b: string): boolean {
  return a === b || levenshtein(a, b) <= Math.min(tolerance(a), tolerance(b));
}

export type MatchType = 'exact' | 'contains' | 'starts_with' | 'any';

/**
 * Compara a mensagem com UMA palavra-chave (pode ter várias palavras, ex.: "quero pedir").
 * Usa comparação palavra a palavra com tolerância a erro de digitação.
 */
export function matchKeyword(message: string, keyword: string, type: MatchType): boolean {
  if (type === 'any') return true;
  const msg = normalize(message).split(' ').filter(Boolean);
  const kw = normalize(keyword).split(' ').filter(Boolean);
  if (!kw.length || !msg.length) return false;

  const seqAt = (start: number) => kw.every((w, i) => msg[start + i] !== undefined && wordsMatch(msg[start + i]!, w));

  switch (type) {
    case 'exact':
      return msg.length === kw.length && seqAt(0);
    case 'starts_with':
      return seqAt(0);
    case 'contains':
      for (let i = 0; i + kw.length <= msg.length; i++) if (seqAt(i)) return true;
      return false;
  }
}

export function matchAny(message: string, keywords: string[], type: MatchType): boolean {
  if (type === 'any') return true;
  return keywords.some((k) => matchKeyword(message, k, type));
}

export function pickRandom<T>(arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}
