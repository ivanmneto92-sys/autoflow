import { createClient } from '@supabase/supabase-js';

// Projeto Supabase do autoflow. A chave publicável é pública por natureza (vai para o navegador).
// Para trocar, crie web/.env.local com VITE_SUPABASE_URL e VITE_SUPABASE_KEY.
const url = import.meta.env.VITE_SUPABASE_URL ?? 'https://ijwhlzkdxsvsdresbler.supabase.co';
const key = import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_NwY-y3_17FmWkZUp-MTNew_dRs-J7LV';

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'autoflow-auth' },
});
