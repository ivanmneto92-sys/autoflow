import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon, useToast } from './ui';

const items = [
  { to: '/', label: 'Painel', icon: 'home', end: true },
  { to: '/fluxos', label: 'Fluxos', icon: 'flow' },
  { to: '/modelos', label: 'Modelos prontos', icon: 'grid' },
  { to: '/gatilhos', label: 'Gatilhos', icon: 'zap' },
  { to: '/publicacoes', label: 'Publicações', icon: 'calendar' },
  { to: '/simulador', label: 'Simulador', icon: 'play' },
  { to: '/pedidos', label: 'Pedidos', icon: 'bag' },
  { to: '/cupons', label: 'Cupons', icon: 'ticket' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/contatos', label: 'Contatos', icon: 'users' },
  { to: '/instagram', label: 'Instagram', icon: 'instagram' },
  { to: '/configuracoes', label: 'Configurações', icon: 'settings' },
];

export function Layout() {
  const { workspaces, workspace, selectWorkspace, session, signOut } = useSession();
  const newOrders = useOrderAlerts(workspace?.id);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 16l5-8 4 5 7-9" />
            </svg>
          </div>
          autoflow
        </div>
        {workspaces.length > 1 && (
          <select
            className="select"
            style={{ marginBottom: 12 }}
            value={workspace?.id ?? ''}
            onChange={(e) => {
              selectWorkspace(e.target.value);
              window.location.href = '/';
            }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        {workspaces.length === 1 && <div className="muted small" style={{ padding: '0 10px 12px' }}>{workspace?.name}</div>}
        <nav className="nav">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end}>
              <Icon name={i.icon} />
              {i.label}
              {i.to === '/pedidos' && newOrders > 0 && (
                <span className="badge badge-danger" style={{ marginLeft: 'auto' }}>
                  {newOrders}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="muted small" style={{ padding: '0 10px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session?.user.email}
          </div>
          <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={signOut}>
            <Icon name="logout" /> Sair
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

/** Toca um "plim" curto (sem arquivo de áudio). */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const tone = (freq: number, start: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.35);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + 0.4);
    };
    tone(880, 0);
    tone(1320, 0.18);
    setTimeout(() => ctx.close(), 1000);
  } catch {
    /* sem áudio */
  }
}

/** Confere pedidos novos a cada 15 s em qualquer página: som, aviso do sistema e contador no menu. */
function useOrderAlerts(workspaceId: string | undefined) {
  const toast = useToast();
  const [count, setCount] = useState(0);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    last.current = null;
    let stop = false;
    const check = async () => {
      try {
        const r = await api<{ new_count: number; last_number: number }>('/app/orders/summary');
        if (stop) return;
        setCount(r.new_count);
        if (last.current !== null && r.last_number > last.current) {
          beep();
          toast(`🧾 Novo pedido #${r.last_number}!`);
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted')
              new Notification('Novo pedido no autoflow', { body: `Pedido #${r.last_number} chegou pelo Direct` });
          } catch {
            /* ignore */
          }
        }
        last.current = r.last_number;
      } catch {
        /* API fora do ar: tenta de novo depois */
      }
    };
    check();
    const t = setInterval(check, 15_000);
    window.addEventListener('autoflow:orders-changed', check);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener('autoflow:orders-changed', check);
    };
  }, [workspaceId, toast]);
  return count;
}
