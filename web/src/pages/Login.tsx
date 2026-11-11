import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export function Login() {
  // ?cadastro (link da landing page) já abre na criação de conta
  const [mode, setMode] = useState<'in' | 'up'>(() => (new URLSearchParams(window.location.search).has('cadastro') ? 'up' : 'in'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    if (mode === 'in') {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
      if (error) setError(error.message);
      else if (!data.session) setInfo('Conta criada! Confirme pelo link que enviamos para o seu e-mail e depois faça login.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-body stack" style={{ padding: 28 }}>
          <div className="brand" style={{ padding: 0 }}>
            <div className="brand-logo">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 16l5-8 4 5 7-9" />
              </svg>
            </div>
            autoflow
          </div>
          <div>
            <h1>{mode === 'in' ? 'Entrar' : 'Criar conta'}</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Automação de Instagram para o seu negócio.
            </p>
          </div>
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label className="label">E-mail</label>
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label className="label">Senha</label>
              <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <div className="alert alert-danger">{error}</div>}
            {info && <div className="alert alert-success">{info}</div>}
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Aguarde…' : mode === 'in' ? 'Entrar' : 'Criar conta'}
            </button>
          </form>
          <p className="muted small" style={{ textAlign: 'center' }}>
            {mode === 'in' ? 'Ainda não tem conta? ' : 'Já tem conta? '}
            <a href="#" onClick={(e) => (e.preventDefault(), setMode(mode === 'in' ? 'up' : 'in'), setError(null), setInfo(null))}>
              {mode === 'in' ? 'Criar conta' : 'Entrar'}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
