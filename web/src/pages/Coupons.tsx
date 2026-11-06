import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, formatDateTime } from '../lib/api';
import { useSession } from '../lib/session';

interface Campaign {
  id: string;
  name: string;
  discount: string;
  mode: 'generated' | 'list';
  prefix: string;
  valid_days: number | null;
  archived: boolean;
  created_at: string;
  given: number;
  redeemed: number;
  available: number;
  last_given_at: string | null;
}

interface CodeRow {
  code: string;
  assigned_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_username: string | null;
}

interface Lookup extends CodeRow {
  campaign_name: string;
  discount: string;
  status: 'valid' | 'used' | 'expired' | 'not_given';
}

const STATUS: Record<Lookup['status'], { label: string; cls: string }> = {
  valid: { label: 'Válido', cls: 'badge-success' },
  used: { label: 'Já usado', cls: 'badge-warning' },
  expired: { label: 'Vencido', cls: 'badge-danger' },
  not_given: { label: 'Não entregue', cls: '' },
};

const who = (r: { contact_name: string | null; contact_username: string | null }) =>
  r.contact_name || r.contact_username ? `${r.contact_name ?? ''}${r.contact_username ? ` @${r.contact_username}` : ''}`.trim() : 'Cliente';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '');

export function Coupons() {
  const { workspace } = useSession();
  const camps = useLoad(() => api<Campaign[]>('/app/coupons'), [workspace?.id]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Campaign | null>(null);
  const list = camps.data ?? [];
  const active = list.filter((c) => !c.archived);
  const archived = list.filter((c) => c.archived);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Cupons</h1>
          <p className="muted">Cada pessoa recebe um código só dela pelo Direct. Na hora da compra, digite o código aqui para dar baixa.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Nova campanha
        </button>
      </div>

      <RedeemBox onChange={() => camps.reload()} />

      <ErrorBox error={camps.error} />
      {camps.loading && !camps.data ? (
        <Loading />
      ) : !list.length ? (
        <div className="card">
          <Empty
            title="Nenhuma campanha de cupom"
            text="Crie uma campanha (ex.: 10% OFF para quem comentar) e use a ação “Entregar cupom único” num fluxo."
            action={
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Icon name="plus" /> Nova campanha
              </button>
            }
          />
        </div>
      ) : (
        <>
          <div className="coupon-grid">
            {active.map((c) => (
              <CampaignCard key={c.id} c={c} onOpen={() => setOpen(c)} />
            ))}
          </div>
          {archived.length > 0 && (
            <>
              <h3 className="muted" style={{ margin: '24px 0 10px', fontSize: 14 }}>
                Arquivadas
              </h3>
              <div className="coupon-grid">
                {archived.map((c) => (
                  <CampaignCard key={c.id} c={c} onOpen={() => setOpen(c)} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {creating && (
        <NewCampaign
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            camps.reload();
          }}
        />
      )}
      {open && (
        <CampaignModal
          c={list.find((x) => x.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onChange={() => camps.reload()}
        />
      )}
    </div>
  );
}

function CampaignCard({ c, onOpen }: { c: Campaign; onOpen: () => void }) {
  const rate = c.given ? Math.round((c.redeemed / c.given) * 100) : 0;
  return (
    <button className="card coupon-card" onClick={onOpen} style={c.archived ? { opacity: 0.6 } : undefined}>
      <div className="row-between">
        <b style={{ fontSize: 15 }}>{c.name}</b>
        <span className="badge">{c.mode === 'list' ? 'Lista' : 'Gerado'}</span>
      </div>
      {c.discount && <div className="coupon-discount">{c.discount}</div>}
      <div className="coupon-stats">
        <div>
          <b>{c.given}</b>
          <span>entregues</span>
        </div>
        <div>
          <b>{c.redeemed}</b>
          <span>usados ({rate}%)</span>
        </div>
        {c.mode === 'list' ? (
          <div>
            <b style={c.available === 0 ? { color: 'var(--danger)' } : undefined}>{c.available}</b>
            <span>livres</span>
          </div>
        ) : (
          <div>
            <b>{c.valid_days ? `${c.valid_days}d` : '—'}</b>
            <span>validade</span>
          </div>
        )}
      </div>
      <div className="muted small">
        {c.mode === 'generated' ? `Códigos: ${c.prefix ? `${c.prefix}-` : ''}XXXXXX` : `${c.given + c.available} códigos importados`}
        {c.last_given_at ? ` · último ${formatDateTime(c.last_given_at)}` : ''}
      </div>
    </button>
  );
}

/** Baixa no balcão: digita o código, confere e marca como usado. */
function RedeemBox({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [res, setRes] = useState<Lookup | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setErr('');
    try {
      setRes(await api<Lookup>(`/app/coupons/lookup?code=${encodeURIComponent(code.trim())}`));
    } catch (e) {
      setRes(null);
      setErr((e as Error).message);
    }
    setBusy(false);
  }

  async function redeem(undo = false) {
    if (!res) return;
    try {
      const r = await api<Lookup>('/app/coupons/redeem', { body: { code: res.code, undo } });
      setRes(r);
      toast(undo ? 'Baixa desfeita' : `Cupom ${r.code} marcado como usado ✓`);
      onChange();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-body stack-sm">
        <form className="row" onSubmit={lookup}>
          <input
            className="input mono"
            style={{ maxWidth: 320, textTransform: 'uppercase' }}
            placeholder="Digite o código do cliente"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setRes(null);
              setErr('');
            }}
          />
          <button className="btn btn-primary" disabled={busy || !code.trim()}>
            {busy ? 'Conferindo…' : 'Conferir cupom'}
          </button>
        </form>
        {err && <div className="alert alert-danger">{err}</div>}
        {res && (
          <div className="coupon-result">
            <div className="row wrap" style={{ gap: 8 }}>
              <b className="mono" style={{ fontSize: 17 }}>
                {res.code}
              </b>
              <span className={`badge ${STATUS[res.status].cls}`}>{STATUS[res.status].label}</span>
            </div>
            <div className="small">
              <b>{res.campaign_name}</b>
              {res.discount ? ` — ${res.discount}` : ''}
            </div>
            {res.assigned_at && (
              <div className="small muted">
                Entregue para <b>{who(res)}</b> em {formatDateTime(res.assigned_at)}
                {res.expires_at ? ` · válido até ${fmtDate(res.expires_at)}` : ''}
                {res.redeemed_at ? ` · usado em ${formatDateTime(res.redeemed_at)}` : ''}
              </div>
            )}
            <div className="row" style={{ marginTop: 4 }}>
              {res.status === 'valid' && (
                <button className="btn btn-primary btn-sm" onClick={() => redeem()}>
                  <Icon name="check" /> Marcar como usado
                </button>
              )}
              {res.status === 'used' && (
                <button className="btn btn-sm" onClick={() => redeem(true)}>
                  Desfazer baixa
                </button>
              )}
              {res.contact_id && (
                <Link className="btn btn-sm" to={`/inbox/${res.contact_id}`}>
                  <Icon name="inbox" size={15} /> Conversa
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NewCampaign({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [discount, setDiscount] = useState('');
  const [mode, setMode] = useState<'generated' | 'list'>('generated');
  const [prefix, setPrefix] = useState('');
  const [days, setDays] = useState('7');
  const [codes, setCodes] = useState('');
  const [busy, setBusy] = useState(false);
  const cleanPrefix = prefix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  const codeCount = codes.split(/[\s,;]+/).filter(Boolean).length;

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ added: number; skipped: number }>('/app/coupons', {
        body: { name, discount, mode, prefix, valid_days: days ? Number(days) : null, codes: mode === 'list' ? codes : '' },
      });
      toast(mode === 'list' ? `Campanha criada com ${r.added} códigos${r.skipped ? ` (${r.skipped} repetidos ignorados)` : ''}` : 'Campanha criada');
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Nova campanha de cupom"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? 'Criando…' : 'Criar campanha'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="label">Nome (só você vê)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Black Friday seguidores" autoFocus maxLength={80} />
        </div>
        <div className="field">
          <label className="label">Benefício (aparece para o cliente)</label>
          <input className="input" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="Ex.: 10% OFF, Frete grátis, Sobremesa grátis" maxLength={80} />
        </div>
        <div className="field">
          <label className="label">Códigos</label>
          <div className="seg">
            <button className={mode === 'generated' ? 'active' : ''} onClick={() => setMode('generated')} type="button">
              Gerar automático
            </button>
            <button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')} type="button">
              Usar minha lista
            </button>
          </div>
        </div>
        {mode === 'generated' ? (
          <div className="field">
            <label className="label">Começo do código (opcional)</label>
            <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Ex.: PIZZA" maxLength={30} />
            <div className="hint">
              Exemplo: <span className="mono">{cleanPrefix ? `${cleanPrefix}-` : ''}K7M2QX</span>. Um código diferente para cada pessoa, sem limite.
            </div>
          </div>
        ) : (
          <div className="field">
            <label className="label">Cole os códigos (um por linha)</label>
            <textarea className="textarea mono" rows={6} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'NUVEM-A1B2\nNUVEM-C3D4\n…'} />
            <div className="hint">
              Use quando os códigos vêm da sua loja (Nuvemshop, Shopify, iFood…). {codeCount ? `${codeCount} códigos.` : ''} Quando acabarem, o fluxo avisa — dá para
              adicionar mais depois.
            </div>
          </div>
        )}
        <div className="field">
          <label className="label">Validade depois de receber</label>
          <select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="">Sem validade</option>
            {[1, 2, 3, 7, 15, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? 'dia' : 'dias'}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

function CampaignModal({ c, onClose, onChange }: { c: Campaign; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const codes = useLoad(() => api<CodeRow[]>(`/app/coupons/${c.id}/codes${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`), [c.id, q]);
  const [more, setMore] = useState('');
  const [discount, setDiscount] = useState(c.discount);

  async function patch(body: Record<string, unknown>, msg: string) {
    try {
      await api(`/app/coupons/${c.id}`, { method: 'PATCH', body });
      toast(msg);
      onChange();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  async function addCodes() {
    try {
      const r = await api<{ added: number; skipped: number }>(`/app/coupons/${c.id}/codes`, { body: { codes: more } });
      toast(`${r.added} códigos adicionados${r.skipped ? ` (${r.skipped} repetidos ignorados)` : ''}`);
      setMore('');
      onChange();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  function exportCsv() {
    const rows = [['codigo', 'cliente', 'usuario', 'recebido_em', 'valido_ate', 'usado_em']].concat(
      (codes.data ?? []).map((r) => [r.code, r.contact_name ?? '', r.contact_username ?? '', r.assigned_at, r.expires_at ?? '', r.redeemed_at ?? '']),
    );
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `cupons-${c.name.replace(/[^\w-]+/g, '-').toLowerCase()}.csv`;
    a.click();
  }

  return (
    <Modal wide title={`🎟 ${c.name}`} onClose={onClose}>
      <div className="stack">
        <div className="coupon-stats" style={{ maxWidth: 420 }}>
          <div>
            <b>{c.given}</b>
            <span>entregues</span>
          </div>
          <div>
            <b>{c.redeemed}</b>
            <span>usados</span>
          </div>
          <div>
            <b>{c.mode === 'list' ? c.available : c.valid_days ? `${c.valid_days}d` : '—'}</b>
            <span>{c.mode === 'list' ? 'livres' : 'validade'}</span>
          </div>
        </div>

        <div className="row wrap">
          <input className="input" style={{ maxWidth: 260 }} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="Benefício" />
          {discount !== c.discount && (
            <button className="btn btn-sm" onClick={() => patch({ discount }, 'Benefício atualizado')}>
              Salvar
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-sm" onClick={exportCsv} disabled={!codes.data?.length}>
            Exportar CSV
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => patch({ archived: !c.archived }, c.archived ? 'Campanha reativada' : 'Campanha arquivada')}>
            {c.archived ? 'Reativar' : 'Arquivar'}
          </button>
        </div>
        {c.archived && <div className="alert alert-warning">Arquivada: os fluxos que usam esta campanha não entregam mais cupons (coupon_status = indisponivel).</div>}

        {c.mode === 'list' && (
          <div className="field">
            <label className="label">Adicionar mais códigos</label>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <textarea className="textarea mono" rows={2} value={more} onChange={(e) => setMore(e.target.value)} placeholder="Um por linha" />
              <button className="btn btn-sm" onClick={addCodes} disabled={!more.trim()}>
                Adicionar
              </button>
            </div>
          </div>
        )}

        <div className="row-between">
          <div className="label" style={{ margin: 0 }}>
            Quem recebeu
          </div>
          <input className="input" style={{ maxWidth: 220 }} placeholder="Buscar código ou nome" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {codes.loading && !codes.data ? (
          <Loading />
        ) : !codes.data?.length ? (
          <p className="muted small">{q ? 'Nada encontrado.' : 'Ninguém recebeu ainda. Use a ação “Entregar cupom único” num fluxo.'}</p>
        ) : (
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Cliente</th>
                  <th>Recebido</th>
                  <th>Validade</th>
                  <th>Uso</th>
                </tr>
              </thead>
              <tbody>
                {codes.data.map((r) => (
                  <tr key={r.code}>
                    <td className="mono">{r.code}</td>
                    <td>{r.contact_id ? <Link to={`/inbox/${r.contact_id}`}>{who(r)}</Link> : who(r)}</td>
                    <td className="muted">{formatDateTime(r.assigned_at)}</td>
                    <td className="muted">{fmtDate(r.expires_at) || '—'}</td>
                    <td>{r.redeemed_at ? <span className="badge badge-success">Usado {fmtDate(r.redeemed_at)}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
