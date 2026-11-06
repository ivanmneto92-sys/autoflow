import { supabase } from './supabase';

let currentWorkspace: string | null = null;
try {
  currentWorkspace = localStorage.getItem('autoflow-ws');
} catch {
  /* armazenamento indisponível */
}

export function setWorkspace(id: string | null) {
  currentWorkspace = id;
  try {
    if (id) localStorage.setItem('autoflow-ws', id);
    else localStorage.removeItem('autoflow-ws');
  } catch {
    /* ignore */
  }
}
export const getWorkspace = () => currentWorkspace;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: any,
  ) {
    super(message);
  }
}

// Em produção o painel (autoflow.a2bads.com.br) chama a API no subdomínio dela; localmente usa o proxy do Vite
const BASE =
  import.meta.env.VITE_API_URL ??
  (typeof location !== 'undefined' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? 'https://autoflow-api.a2bads.com.br' : '');

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const headers: Record<string, string> = {};
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  if (currentWorkspace) headers['x-workspace-id'] = currentWorkspace;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      res.status === 502 || res.status === 504 || (typeof body === 'string' && body.includes('ECONNREFUSED'))
        ? 'A API não está respondendo. Confira se o "npm run dev" está rodando.'
        : (body?.error ?? `Erro ${res.status}`);
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Envia um arquivo para a API (corpo bruto) com progresso de 0 a 1. */
type Uploaded = { url: string; kind: 'image' | 'video'; size: number };

/** Acima disso o arquivo sobe em partes (o Cloudflare barra requisições acima de 100 MB). */
const CHUNK_BYTES = 50 * 1024 * 1024;

export async function apiUpload(file: Blob, onProgress?: (p: number) => void): Promise<Uploaded> {
  if (file.size <= CHUNK_BYTES) return sendBlob('/app/media', file, file.type, {}, onProgress);

  // Envio em partes, em ordem; cada parte tenta até 3 vezes
  const id = crypto.randomUUID();
  let last: Uploaded | { received: number } | null = null;
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const piece = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
    const headers = { 'x-upload-id': id, 'x-offset': String(offset), 'x-total': String(file.size) };
    for (let attempt = 1; ; attempt++) {
      try {
        last = await sendBlob<Uploaded | { received: number }>('/app/media/chunk', piece, file.type, headers, (p) =>
          onProgress?.((offset + p * piece.size) / file.size),
        );
        break;
      } catch (e) {
        const status = (e as ApiError).status;
        if (attempt >= 3 || status === 409 || status === 413 || status === 415) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  if (!last || !('url' in last)) throw new ApiError('O envio não terminou. Tente de novo.', 0, null);
  return last;
}

async function sendBlob<T = Uploaded>(path: string, file: Blob, type: string, headers: Record<string, string>, onProgress?: (p: number) => void): Promise<T> {
  const { data } = await supabase.auth.getSession();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    if (data.session) xhr.setRequestHeader('Authorization', `Bearer ${data.session.access_token}`);
    if (currentWorkspace) xhr.setRequestHeader('x-workspace-id', currentWorkspace);
    xhr.setRequestHeader('Content-Type', type);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* resposta sem JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else if (xhr.status === 413) reject(new ApiError(body?.error ?? 'Arquivo grande demais', 413, body));
      else reject(new ApiError(body?.error ?? `Erro ${xhr.status} ao enviar o arquivo`, xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError('Não foi possível enviar o arquivo. Confira se a API está no ar.', 0, null));
    xhr.send(file);
  });
}
