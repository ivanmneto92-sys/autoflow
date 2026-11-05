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
