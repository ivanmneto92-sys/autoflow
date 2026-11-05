import { Link } from 'react-router-dom';
import { ErrorBox, Icon, Loading, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface Overview {
  contacts: number;
  new_contacts_7d: number;
  messages_in_7d: number;
  messages_bot_7d: number;
  flows_started_7d: number;
  flows_completed_7d: number;
  waiting_human: number;
  accounts: number;
  daily: { day: string; messages_in: number; flows_started: number }[];
}

export function Dashboard() {
  const { workspace } = useSession();
  const { data, error, loading } = useLoad(() => api<Overview>('/app/overview'), [workspace?.id]);
  const flows = useLoad(() => api<any[]>('/app/flows'), [workspace?.id]);

  if (loading) return <Loading />;
  const max = Math.max(1, ...(data?.daily ?? []).map((d) => d.messages_in));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Painel</h1>
          <p className="muted">Resumo dos últimos 7 dias em {workspace?.name}.</p>
        </div>
      </div>
      <ErrorBox error={error} />

      {data && data.accounts === 0 && (
        <div className="card card-body row-between" style={{ marginBottom: 16 }}>
          <div>
            <h3>Conecte seu Instagram</h3>
            <p className="muted" style={{ marginTop: 4 }}>
              Para o robô começar a responder, conecte a conta profissional do seu negócio.
            </p>
          </div>
          <Link to="/instagram" className="btn btn-primary">
            <Icon name="instagram" /> Conectar
          </Link>
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 14 }}>
            <Stat label="Mensagens recebidas" value={data.messages_in_7d} />
            <Stat label="Respostas do robô" value={data.messages_bot_7d} />
            <Stat label="Novos contatos" value={data.new_contacts_7d} sub={`${data.contacts} no total`} />
            <Stat label="Fluxos iniciados" value={data.flows_started_7d} sub={`${data.flows_completed_7d} caminhos finalizados`} />
          </div>

          <div className="grid grid-3">
            <div className="card" style={{ gridColumn: 'span 2' }}>
              <div className="card-header">
                <h3>Mensagens por dia</h3>
                <span className="muted small">últimos 14 dias</span>
              </div>
              <div className="card-body">
                <div className="bar-chart">
                  {data.daily.map((d) => (
                    <div
                      key={d.day}
                      className="bar"
                      style={{ height: `${(d.messages_in / max) * 100}%` }}
                      data-label={`${d.day.slice(8, 10)}/${d.day.slice(5, 7)}: ${d.messages_in}`}
                    />
                  ))}
                </div>
                <div className="row-between muted small" style={{ marginTop: 6 }}>
                  <span>{fmt(data.daily[0]?.day)}</span>
                  <span>hoje</span>
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <h3>Atendimento</h3>
              </div>
              <div className="card-body stack">
                <div>
                  <div className="muted small">Aguardando atendente</div>
                  <div className="stat-value">{data.waiting_human}</div>
                </div>
                <Link to="/inbox" className="btn">
                  <Icon name="inbox" /> Abrir inbox
                </Link>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-header">
          <h3>Fluxos</h3>
          <Link to="/fluxos" className="btn btn-sm">
            Ver todos
          </Link>
        </div>
        {flows.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Iniciados (30d)</th>
                <th>Concluídos (30d)</th>
              </tr>
            </thead>
            <tbody>
              {flows.data.slice(0, 5).map((f) => (
                <tr key={f.id}>
                  <td>
                    <Link to={`/fluxos/${f.id}`}>{f.name}</Link>
                  </td>
                  <td>{f.status === 'published' ? <span className="badge badge-success">Publicado</span> : <span className="badge">Rascunho</span>}</td>
                  <td>{f.started_30d}</td>
                  <td>{f.completed_30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body muted">Nenhum fluxo ainda.</div>
        )}
      </div>
    </div>
  );
}

function fmt(day?: string) {
  return day ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : '';
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value.toLocaleString('pt-BR')}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
