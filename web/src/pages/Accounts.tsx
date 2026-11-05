import type React from 'react';
import { useState } from 'react';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, formatDateTime } from '../lib/api';
import { useSession } from '../lib/session';

interface Account {
  id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  status: string;
  connected_at: string;
  token_expires_at: string | null;
}

const statusBadge: Record<string, React.ReactElement> = {
  active: <span className="badge badge-success"><span className="dot" /> Conectada</span>,
  token_expired: <span className="badge badge-danger"><span className="dot" /> Reconectar</span>,
  disconnected: <span className="badge"><span className="dot" /> Desconectada</span>,
};

export function Accounts() {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api<Account[]>('/app/accounts'), [workspace?.id]);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intro, setIntro] = useState(false);
  const returned = new URLSearchParams(window.location.search).get('connected')?.split(',') ?? [];
  const connected = (data ?? []).filter((account) => account.status === 'active' && returned.includes(account.username));

  async function connect(open: boolean) {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/app/connect-link', { body: {} });
      if (open) window.location.assign(url);
      else setLink(url);
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  async function disconnect(a: Account) {
    if (!confirm(`Desconectar @${a.username}? O robô para de responder nessa conta.`)) return;
    await api(`/app/accounts/${a.id}`, { method: 'DELETE' });
    reload();
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Instagram</h1>
          <p className="muted">Contas conectadas a este negócio.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={reload}>
            <Icon name="refresh" /> Atualizar
          </button>
          <button className="btn btn-primary" onClick={() => setIntro(true)} disabled={busy}>
            <Icon name="instagram" /> Conectar Instagram
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {connected.length > 0 && (
        <div className="alert alert-success" style={{ marginBottom: 14 }}>
          Instagram conectado: <b>@{connected.map((account) => account.username).join(', @')}</b>. Agora crie um fluxo e um gatilho para o robô começar a responder.
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        {loading ? (
          <Loading />
        ) : data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Conta</th>
                <th>Status</th>
                <th>Conectada em</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="row">
                      {a.profile_picture_url ? (
                        <img src={a.profile_picture_url} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
                      ) : (
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--surface-2)' }} />
                      )}
                      <div>
                        <div style={{ fontWeight: 600 }}>@{a.username}</div>
                        {a.name && <div className="muted small">{a.name}</div>}
                      </div>
                    </div>
                  </td>
                  <td>{statusBadge[a.status] ?? a.status}</td>
                  <td className="muted">{formatDateTime(a.connected_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {a.status !== 'active' ? (
                      <button className="btn btn-sm btn-primary" onClick={() => setIntro(true)}>
                        Reconectar
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-danger" onClick={() => disconnect(a)}>
                        Desconectar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title="Nenhuma conta conectada"
            text="Clique em Conectar Instagram e faça login com a conta profissional do negócio."
            action={
              <button className="btn btn-primary" onClick={() => setIntro(true)} disabled={busy}>
                <Icon name="instagram" /> Conectar Instagram
              </button>
            }
          />
        )}
      </div>

      {intro && (
        <Modal title="Conectar Instagram" onClose={() => setIntro(false)}>
          <div className="stack">
            <div>
              <h3>Entre com a sua conta profissional</h3>
              <p className="muted" style={{ marginTop: 6 }}>
                Na tela da Meta, escolha Continuar com o Instagram e entre com sua conta profissional. Selecione a conta que quer conectar, revise as permissões e confirme.
              </p>
            </div>
            <button
              className="btn btn-primary"
              style={{ height: 42 }}
              disabled={busy}
              onClick={() => connect(true)}
            >
              {busy ? 'Abrindo a Meta…' : 'Continuar para o login'}
            </button>
            <p className="muted small">
              A conta precisa ser <b>Profissional</b> (Comercial ou Criador). Se você ainda não tem, mude no app do Instagram em Configurações → Tipo de conta e ferramentas.
            </p>
          </div>
        </Modal>
      )}

      <div className="card card-body stack">
        <h3>Conectar a conta de um cliente</h3>
        <p className="muted">
          Gere um link e envie para o dono do negócio. Ele faz login no Instagram e autoriza — sem precisar acessar o painel. O link vale por 7 dias.
        </p>
        <div className="row">
          <button className="btn" onClick={() => connect(false)} disabled={busy}>
            <Icon name="link" /> Gerar link
          </button>
          {link && (
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard.writeText(link);
                toast('Link copiado');
              }}
            >
              <Icon name="copy" /> Copiar
            </button>
          )}
        </div>
        {link && <div className="input mono" style={{ wordBreak: 'break-all' }}>{link}</div>}
        <div className="alert alert-info">
          A conta precisa ser <b>Profissional</b> (Comercial ou Criador). Depois de conectar, ative no Instagram: Configurações → Mensagens → Ferramentas conectadas →{' '}
          <b>Permitir acesso a mensagens</b>.
        </div>
      </div>
    </div>
  );
}
