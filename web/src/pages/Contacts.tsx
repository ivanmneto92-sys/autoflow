import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, useLoad } from '../components/ui';
import { api, timeAgo } from '../lib/api';
import { useSession } from '../lib/session';

interface Contact {
  id: string;
  username: string | null;
  name: string | null;
  tags: string[];
  fields: Record<string, unknown>;
  bot_paused_until: string | null;
  created_at: string;
  updated_at: string;
}

export function Contacts() {
  const { workspace } = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, loading } = useLoad(
    () => api<Contact[]>(`/app/contacts?limit=300${search ? `&q=${encodeURIComponent(search)}` : ''}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`),
    [workspace?.id, search, tag],
  );
  const tags = useLoad(() => api<{ name: string; contacts: number }[]>('/app/tags'), [workspace?.id]);

  function exportCsv() {
    if (!data) return;
    const fieldKeys = [...new Set(data.flatMap((c) => Object.keys(c.fields)))];
    const head = ['username', 'nome', 'tags', ...fieldKeys, 'criado_em'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = data.map((c) => [c.username, c.name, c.tags.join('; '), ...fieldKeys.map((k) => c.fields[k]), c.created_at].map(esc).join(','));
    const blob = new Blob(['﻿' + [head.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'contatos.csv';
    a.click();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Contatos</h1>
          <p className="muted">Todo mundo que interagiu com a conta, com as tags e os dados coletados pelos fluxos.</p>
        </div>
        <button className="btn" onClick={exportCsv} disabled={!data?.length}>
          Exportar CSV
        </button>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <input
          className="input"
          placeholder="Buscar por @ ou nome"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setSearch(q)}
          style={{ maxWidth: 320 }}
        />
        <button className="btn" onClick={() => setSearch(q)}>
          Buscar
        </button>
        <select className="select" style={{ maxWidth: 220 }} value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">Todas as tags</option>
          {tags.data?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.contacts})
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        {loading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty title="Nenhum contato" text="Quando alguém mandar mensagem ou comentar, aparece aqui." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Contato</th>
                <th>Tags</th>
                <th>Dados</th>
                <th>Última atividade</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/inbox/${c.id}`)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.username ? `@${c.username}` : 'Sem @'}</div>
                    {c.name && <div className="muted small">{c.name}</div>}
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 4 }}>
                      {c.tags.map((t) => (
                        <span key={t} className="badge badge-primary">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="muted small">
                    {Object.entries(c.fields)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </td>
                  <td className="muted">{timeAgo(c.updated_at)}</td>
                  <td>
                    <Icon name="inbox" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
