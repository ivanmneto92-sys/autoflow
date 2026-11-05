/**
 * Arquivos das publicações: ficam numa pasta local (MEDIA_DIR) e são servidos em PUBLIC_BASE_URL/media/<workspace>/<arquivo>.
 * A Meta baixa a mídia por essa URL pública na hora de publicar. Os nomes são UUIDs aleatórios (não dá para adivinhar).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';

/** Tipos aceitos no upload → extensão do arquivo. Imagem só JPG: é o único formato que a API de publicação aceita. */
export const MEDIA_TYPES_ALLOWED: Record<string, { ext: string; kind: 'image' | 'video' }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
};

export const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', mp4: 'video/mp4', mov: 'video/quicktime' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const FILE_RE = new RegExp(`^${UUID}\\.(jpg|mp4|mov)$`);
export const WS_RE = new RegExp(`^${UUID}$`);

export const mediaRoot = () => resolve(process.cwd(), config().MEDIA_DIR);

export function mediaPath(workspaceId: string, file: string): string | null {
  if (!WS_RE.test(workspaceId) || !FILE_RE.test(file)) return null;
  return join(mediaRoot(), workspaceId, file);
}

export const mediaUrl = (workspaceId: string, file: string) => `${config().PUBLIC_BASE_URL}/media/${workspaceId}/${file}`;

/** Confere se a URL é de um arquivo nosso, deste workspace, que existe no disco. Devolve o nome do arquivo. */
export function ownMediaFile(url: string, workspaceId: string): string | null {
  const prefix = `${config().PUBLIC_BASE_URL}/media/${workspaceId}/`;
  if (!url.startsWith(prefix)) return null;
  const file = url.slice(prefix.length);
  const path = mediaPath(workspaceId, file);
  return path && existsSync(path) ? file : null;
}
