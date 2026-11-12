/** Campos do perfil do Instagram que o robô guarda no contato (não são dados digitados pelo cliente). */
export const INTERNAL_FIELDS = new Set(['ig_seguidores', 'ig_verificado', 'ig_perfil_em', 'seguidor_desde', 'seguiu_pela_automacao']);

/** Quem merece destaque: 10 mil seguidores ou mais, ou selo de verificado. */
export const INFLUENCER_MIN = 10_000;

export function followersOf(fields: Record<string, unknown> | undefined): number | null {
  const v = fields?.ig_seguidores;
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
}

export const isVerified = (fields: Record<string, unknown> | undefined) => fields?.ig_verificado === 'sim';

export const isInfluencer = (fields: Record<string, unknown> | undefined) => (followersOf(fields) ?? 0) >= INFLUENCER_MIN || isVerified(fields);

/** 830 · 12,4 mil · 1,2 mi */
export function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString('pt-BR')} mil`;
  if (n >= 1_000) return `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return n.toLocaleString('pt-BR');
}

/** Campos digitados/capturados, sem os internos. */
export const visibleFields = (fields: Record<string, unknown>) => Object.entries(fields).filter(([k]) => !INTERNAL_FIELDS.has(k));
