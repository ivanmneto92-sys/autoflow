import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export function Onboarding() {
  const { refresh, signOut, session, meError } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/app/workspaces', { body: { name } });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-body stack" style={{ padding: 28 }}>
          <div>
            <h1>Bem-vindo!</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Crie o espaço do seu negócio. É nele que ficam a conta do Instagram, os fluxos e os contatos.
            </p>
          </div>
          {meError && <div className="alert alert-danger">{meError}</div>}
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label className="label">Nome do negócio</label>
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Pizzaria do Zé" autoFocus />
            </div>
            {error && <div className="alert alert-danger">{error}</div>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Criando…' : 'Criar e continuar'}
            </button>
          </form>
          <p className="muted small" style={{ textAlign: 'center' }}>
            Logado como {session?.user.email} ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), signOut())}>
              sair
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
