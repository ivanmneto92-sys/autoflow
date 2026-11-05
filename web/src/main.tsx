import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { Layout } from './components/Layout';
import { Loading, ToastProvider } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { Accounts } from './pages/Accounts';
import { Contacts } from './pages/Contacts';
import { Dashboard } from './pages/Dashboard';
import { FlowEditor } from './pages/FlowEditor';
import { Flows } from './pages/Flows';
import { Inbox } from './pages/Inbox';
import { Login } from './pages/Login';
import { Onboarding } from './pages/Onboarding';
import { Settings } from './pages/Settings';
import { Simulator } from './pages/Simulator';
import { Triggers } from './pages/Triggers';

function Root() {
  const { ready, session, workspace, workspaces, meError } = useSession();
  if (!ready) return <Loading />;
  if (!session) return <Login />;
  if (!workspace || (!workspaces.length && !meError)) return <Onboarding />;
  return (
    <Routes>
      <Route path="/fluxos/:id" element={<FlowEditor />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/fluxos" element={<Flows />} />
        <Route path="/gatilhos" element={<Triggers />} />
        <Route path="/simulador" element={<Simulator />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/inbox/:id" element={<Inbox />} />
        <Route path="/contatos" element={<Contacts />} />
        <Route path="/instagram" element={<Accounts />} />
        <Route path="/configuracoes" element={<Settings />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
