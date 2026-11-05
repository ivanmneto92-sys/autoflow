import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, timeAgo } from '../lib/api';
import { useSession } from '../lib/session';

interface Flow {
  id: string;
  name: string;
  status: string;
  updated_at: string;
  published_version: number | null;
  triggers: number;
  started_30d: number;
  completed_30d: number;
}

export function Flows() {
  const { workspace } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api<Flow[]>('/app/flows'), [workspace?.id]);
  const templates = useLoad(() => api<{ id: string; name: string; description: string }[]>('/app/templates'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<string>('');
  const [withTriggers, setWithTriggers] = useState(true);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const f = await api<{ id: string }>('/app/flows', {
        body: { name: name || 'Novo fluxo', template_id: template || undefined, create_triggers: Boolean(template) && withTriggers },
      });
      nav(`/fluxos/${f.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  async function duplicate(f: Flow) {
    await api(`/app/flows/${f.id}/duplicate`, { body: {} });
    toast('Fluxo duplicado');
    reload();
  }

  async function archive(f: Flow) {
    if (!confirm(`Arquivar "${f.name}"? Os gatilhos dele serão desativados.`)) return;
    await api(`/app/flows/${f.id}`, { method: 'DELETE' });
    reload();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fluxos</h1>
          <p className="muted">As conversas automáticas do robô. Cada fluxo é ativado por um ou mais gatilhos.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Novo fluxo
        </button>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        {loading ? (
          <Loading />
        ) : data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Gatilhos</th>
                <th>Iniciados / concluídos (30d)</th>
                <th>Editado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => nav(`/fluxos/${f.id}`)}>
                  <td style={{ fontWeight: 600 }}>{f.name}</td>
                  <td>
                    {f.status === 'published' ? (
                      <span className="badge badge-success">Publicado v{f.published_version}</span>
                    ) : (
                      <span className="badge">Rascunho</span>
                    )}
                  </td>
                  <td>{f.triggers ? <span className="badge badge-primary">{f.triggers} ativo(s)</span> : <span className="muted">nenhum</span>}</td>
                  <td>
                    {f.started_30d} / {f.completed_30d}
                  </td>
                  <td className="muted">{timeAgo(f.updated_at)}</td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" title="Duplicar" onClick={() => duplicate(f)}>
                        <Icon name="copy" />
                      </button>
                      <button className="btn btn-ghost btn-sm btn-danger" title="Arquivar" onClick={() => archive(f)}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title="Nenhum fluxo ainda"
            text="Comece por um modelo pronto ou crie do zero."
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Icon name="plus" /> Novo fluxo
              </button>
            }
          />
        )}
      </div>

      {creating && (
        <Modal
          title="Novo fluxo"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={create} disabled={busy}>
                {busy ? 'Criando…' : 'Criar e abrir editor'}
              </button>
            </>
          }
        >
          <div className="stack">
            <div className="field">
              <label className="label">Nome</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Atendimento e pedidos" autoFocus />
            </div>
            <div className="field">
              <label className="label">Começar de</label>
              <div className="stack-sm">
                <label className="card card-body checkbox" style={{ padding: 12 }}>
                  <input type="radio" checked={!template} onChange={() => setTemplate('')} />
                  <div>
                    <div style={{ fontWeight: 600 }}>Em branco</div>
                    <div className="muted small">Só uma mensagem de boas-vindas.</div>
                  </div>
                </label>
                {templates.data?.map((t) => (
                  <label key={t.id} className="card card-body checkbox" style={{ padding: 12 }}>
                    <input type="radio" checked={template === t.id} onChange={() => setTemplate(t.id)} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div className="muted small">{t.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            {template && (
              <label className="checkbox">
                <input type="checkbox" checked={withTriggers} onChange={(e) => setWithTriggers(e.target.checked)} />
                Criar também os gatilhos sugeridos do modelo
              </label>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}


