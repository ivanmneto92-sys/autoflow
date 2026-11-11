import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QuickAutomation } from '../components/QuickAutomation';
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
  next_post_at: string | null;
  started_30d: number;
  completed_30d: number;
}

export function Flows() {
  const { workspace } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api<Flow[]>('/app/flows'), [workspace?.id]);
  const [creating, setCreating] = useState(false);
  const [quick, setQuick] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const f = await api<{ id: string }>('/app/flows', {
        body: { name: name || 'Novo fluxo' },
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
        <div className="row wrap">
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Novo fluxo
          </button>
          <Link className="btn" to="/modelos">
            <Icon name="grid" /> Modelos prontos
          </Link>
          <button className="btn btn-primary" onClick={() => setQuick(true)}>
            <Icon name="zap" /> Automação rápida
          </button>
        </div>
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
                  <td>
                    <div className="row wrap" style={{ gap: 4 }}>
                      {f.triggers > 0 && <span className="badge badge-primary">{f.triggers} ativo(s)</span>}
                      {f.next_post_at && (
                        <span className="badge badge-warning" title="O gatilho do comentário é criado sozinho quando o post for publicado">
                          🗓 post {postWhen(f.next_post_at)}
                        </span>
                      )}
                      {!f.triggers && !f.next_post_at && <span className="muted">nenhum</span>}
                    </div>
                  </td>
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
            text="O jeito mais rápido: a Automação rápida responde quem comentar e manda o link no Direct em 1 minuto."
            action={
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button className="btn btn-primary" onClick={() => setQuick(true)}>
                  <Icon name="zap" /> Automação rápida
                </button>
                <Link className="btn" to="/modelos">
                  <Icon name="grid" /> Ver modelos prontos
                </Link>
                <button className="btn" onClick={() => setCreating(true)}>
                  <Icon name="plus" /> Criar do zero
                </button>
              </div>
            }
          />
        )}
      </div>

      {quick && <QuickAutomation onClose={() => setQuick(false)} onCreated={(f) => nav(`/fluxos/${f.id}`)} />}

      {creating && (
        <Modal
          title="Novo fluxo em branco"
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
            <Link to="/modelos" className="card card-body tpl-shortcut">
              <span style={{ fontSize: 24 }}>✨</span>
              <div>
                <div style={{ fontWeight: 600 }}>Prefere começar de um modelo pronto?</div>
                <div className="muted small">Dezenas de fluxos para restaurante, loja, serviços, criadores, advogados, contadores e imobiliárias.</div>
              </div>
              <Icon name="external" size={16} />
            </Link>
          </div>
        </Modal>
      )}
    </div>
  );
}



/** "hoje 10:00", "amanhã 12:00" ou "12/11 18:00" */
function postWhen(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (diff === 0) return `hoje ${hm}`;
  if (diff === 1) return `amanhã ${hm}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}
