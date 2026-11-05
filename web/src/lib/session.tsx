import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace, setWorkspace } from './api';
import { supabase } from './supabase';

export interface Workspace {
  id: string;
  name: string;
  role: string;
  settings: {
    whatsapp?: string;
    timezone?: string;
    bot_pause_hours?: number;
    business_hours?: Record<string, [string, string][]>;
  };
}

interface SessionState {
  session: Session | null;
  ready: boolean;
  workspaces: Workspace[];
  workspace: Workspace | null;
  meError: string | null;
  selectWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState>(null as unknown as SessionState);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [wsId, setWsId] = useState<string | null>(getWorkspace());
  const [meError, setMeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ workspaces: Workspace[] }>('/app/me');
      setWorkspaces(me.workspaces);
      setMeError(null);
      const current = me.workspaces.find((w) => w.id === getWorkspace()) ?? me.workspaces[0] ?? null;
      setWorkspace(current?.id ?? null);
      setWsId(current?.id ?? null);
    } catch (e) {
      setMeError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await refresh();
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN') refresh();
      if (event === 'SIGNED_OUT') {
        setWorkspaces([]);
        setWorkspace(null);
        setWsId(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  const value: SessionState = {
    session,
    ready,
    workspaces,
    workspace: workspaces.find((w) => w.id === wsId) ?? null,
    meError,
    selectWorkspace: (id) => {
      setWorkspace(id);
      setWsId(id);
    },
    refresh,
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
