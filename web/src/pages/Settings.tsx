import { useState } from 'react';
import { useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const DAYS: [string, string][] = [
  ['mon', 'Segunda'],
  ['tue', 'Terça'],
  ['wed', 'Quarta'],
  ['thu', 'Quinta'],
  ['fri', 'Sexta'],
  ['sat', 'Sábado'],
  ['sun', 'Domingo'],
];

type Hours = Record<string, [string, string][]>;

export function Settings() {
  const { workspace, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(workspace?.name ?? '');
  const [pause, setPause] = useState(workspace?.settings.bot_pause_hours ?? 12);
  const [hours, setHours] = useState<Hours>(workspace?.settings.business_hours ?? {});
  const [whatsapp, setWhatsapp] = useState(workspace?.settings.whatsapp ?? '');
  const [busy, setBusy] = useState(false);

  const setDay = (day: string, open: boolean) =>
    setHours((h) => {
      const n = { ...h };
      if (open) n[day] = [['18:00', '23:00']];
      else delete n[day];
      return n;
    });
  const setTime = (day: string, i: 0 | 1, v: string) =>
    setHours((h) => {
      const cur: [string, string] = [...(h[day]?.[0] ?? ['18:00', '23:00'])] as [string, string];
      cur[i] = v;
      return { ...h, [day]: [cur, ...(h[day]?.slice(1) ?? [])] };
    });

  async function save() {
    setBusy(true);
    try {
      await api('/app/workspace', { method: 'PATCH', body: { name, settings: { bot_pause_hours: Number(pause), business_hours: hours, whatsapp } } });
      await refresh();
      toast('Configurações salvas');
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-header">
        <div>
          <h1>Configurações</h1>
          <p className="muted">Dados do negócio e comportamento do robô.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar'}
        </button>
      </div>

      <div className="card card-body stack" style={{ marginBottom: 14 }}>
        <div className="field">
          <label className="label">Nome do negócio</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">WhatsApp do negócio</label>
          <input
            className="input mono"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, ''))}
            placeholder="5531999999999"
            style={{ maxWidth: 220 }}
          />
          <span className="hint">Com DDI 55 e DDD, só números. É para onde vão os botões “Abre WhatsApp” dos fluxos.</span>
        </div>
        <div className="field">
          <label className="label">Pausar o robô depois que um atendente responde (horas)</label>
          <input className="input" type="number" min={0} max={168} value={pause} onChange={(e) => setPause(Number(e.target.value))} style={{ maxWidth: 140 }} />
          <span className="hint">Quando alguém da equipe responde (pela inbox ou pelo app do Instagram), o robô fica em silêncio com aquele cliente por esse tempo. 0 = nunca pausa.</span>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Horário de funcionamento</h3>
            <p className="muted small" style={{ marginTop: 2 }}>
              Usado pela condição "Está aberto agora?" nos fluxos. Sem nenhum dia marcado, o sistema considera sempre aberto. Para virar a noite, use um fechamento menor que a abertura (ex.: 18:00 → 02:00).
            </p>
          </div>
        </div>
        <table className="table">
          <tbody>
            {DAYS.map(([key, label]) => {
              const open = Boolean(hours[key]?.length);
              const [o, c] = hours[key]?.[0] ?? ['18:00', '23:00'];
              return (
                <tr key={key}>
                  <td style={{ width: 160 }}>
                    <label className="checkbox">
                      <input type="checkbox" checked={open} onChange={(e) => setDay(key, e.target.checked)} />
                      {label}
                    </label>
                  </td>
                  <td>
                    {open ? (
                      <div className="row">
                        <input className="input" type="time" value={o} onChange={(e) => setTime(key, 0, e.target.value)} style={{ maxWidth: 130 }} />
                        <span className="muted">até</span>
                        <input className="input" type="time" value={c} onChange={(e) => setTime(key, 1, e.target.value)} style={{ maxWidth: 130 }} />
                      </div>
                    ) : (
                      <span className="muted">Fechado</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PaymentsCard />
    </div>
  );
}

interface PayAccount {
  provider: 'mercadopago' | 'asaas';
  sandbox: boolean;
  account_name: string | null;
  webhook_url: string;
  webhook_token?: string;
}

const PROVIDERS = {
  mercadopago: {
    name: 'Mercado Pago',
    help: 'No Mercado Pago: Seu negócio → Configurações → Credenciais (ou developers.mercadopago.com → Suas integrações → Credenciais de produção). Copie o “Access Token” (começa com APP_USR-). Para testar sem dinheiro de verdade, use o das credenciais de teste.',
  },
  asaas: {
    name: 'Asaas',
    help: 'No Asaas: Integrações → Chave de API → Gerar chave. Depois cadastre o webhook abaixo em Integrações → Webhooks (evento de cobranças), com o token de autenticação mostrado aqui.',
  },
} as const;

/** Contas de Pix do negócio (Mercado Pago / Asaas). */
function PaymentsCard() {
  const toast = useToast();
  const data = useLoad(() => api<{ preferred: string | null; accounts: PayAccount[] }>('/app/payments/accounts'), []);
  const [editing, setEditing] = useState<'mercadopago' | 'asaas' | null>(null);
  const [token, setToken] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const accounts = data.data?.accounts ?? [];

  async function connect() {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await api<{ account_name: string }>(`/app/payments/accounts/${editing}`, { method: 'PUT', body: { token, sandbox } });
      toast(`${PROVIDERS[editing].name} conectado: ${r.account_name}`);
      setEditing(null);
      setToken('');
      data.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  async function disconnect(p: 'mercadopago' | 'asaas') {
    if (!confirm(`Desconectar ${PROVIDERS[p].name}? Os fluxos com Pix vão parar de gerar cobrança por essa conta.`)) return;
    await api(`/app/payments/accounts/${p}`, { method: 'DELETE' });
    data.reload();
  }

  async function prefer(p: 'mercadopago' | 'asaas') {
    await api('/app/payments/preferred', { method: 'PUT', body: { provider: p } });
    data.reload();
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header">
        <div>
          <h3>Pagamentos (Pix)</h3>
          <p className="muted small" style={{ marginTop: 2 }}>
            Conecte a conta do negócio. O dinheiro cai direto nela; o autoflow só gera a cobrança e confirma o pagamento.
          </p>
        </div>
      </div>
      <div className="card-body stack">
        {(['mercadopago', 'asaas'] as const).map((p) => {
          const acc = accounts.find((a) => a.provider === p);
          return (
            <div key={p} className="card card-body stack-sm" style={{ background: 'var(--surface-2)' }}>
              <div className="row-between">
                <div className="row">
                  <b>{PROVIDERS[p].name}</b>
                  {acc ? <span className="badge badge-success">Conectado · {acc.account_name}</span> : <span className="badge">Não conectado</span>}
                  {acc?.sandbox && <span className="badge badge-warning">testes</span>}
                  {acc && data.data?.preferred === p && <span className="badge badge-primary">padrão</span>}
                </div>
                <div className="row">
                  {acc && accounts.length > 1 && data.data?.preferred !== p && (
                    <button className="btn btn-sm" onClick={() => prefer(p)}>
                      Usar como padrão
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => (setEditing(p), setToken(''), setSandbox(acc?.sandbox ?? false))}>
                    {acc ? 'Trocar chave' : 'Conectar'}
                  </button>
                  {acc && (
                    <button className="btn btn-sm btn-ghost" onClick={() => disconnect(p)}>
                      Desconectar
                    </button>
                  )}
                </div>
              </div>
              {editing === p && (
                <div className="stack-sm">
                  <span className="hint">{PROVIDERS[p].help}</span>
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    placeholder={p === 'mercadopago' ? 'APP_USR-…' : '$aact_…'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  {p === 'asaas' && (
                    <label className="checkbox small">
                      <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Chave do ambiente de testes (sandbox)
                    </label>
                  )}
                  <div className="row">
                    <button className="btn btn-primary btn-sm" onClick={connect} disabled={busy || token.trim().length < 10}>
                      {busy ? 'Validando…' : 'Validar e salvar'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {acc && p === 'asaas' && (
                <div className="small">
                  <div className="muted">Webhook para cadastrar no Asaas:</div>
                  <div className="mono" style={{ wordBreak: 'break-all' }}>{acc.webhook_url}</div>
                  <div className="muted" style={{ marginTop: 4 }}>Token de autenticação:</div>
                  <div className="mono" style={{ wordBreak: 'break-all' }}>{acc.webhook_token}</div>
                </div>
              )}
              {acc && p === 'mercadopago' && <span className="hint">As confirmações chegam sozinhas: não precisa configurar webhook.</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
