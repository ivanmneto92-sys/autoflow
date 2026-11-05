import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Icon } from './ui';

const items = [
  { to: '/', label: 'Painel', icon: 'home', end: true },
  { to: '/fluxos', label: 'Fluxos', icon: 'flow' },
  { to: '/gatilhos', label: 'Gatilhos', icon: 'zap' },
  { to: '/publicacoes', label: 'Publicações', icon: 'calendar' },
  { to: '/simulador', label: 'Simulador', icon: 'play' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/contatos', label: 'Contatos', icon: 'users' },
  { to: '/instagram', label: 'Instagram', icon: 'instagram' },
  { to: '/configuracoes', label: 'Configurações', icon: 'settings' },
];

export function Layout() {
  const { workspaces, workspace, selectWorkspace, session, signOut } = useSession();
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
