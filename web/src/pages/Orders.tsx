import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, useLoad, useToast } from '../components/ui';
import { api, formatDateTime } from '../lib/api';
import { useSession } from '../lib/session';

type Status = 'new' | 'preparing' | 'delivering' | 'done' | 'cancelled';

export interface Order {
  id: string;
  number: number;
  status: Status;
  summary: string;
  details: { label: string; value: string }[];
  total_cents: number | null;
  payment_status: 'none' | 'pending' | 'paid' | 'expired' | 'refunded';
  created_at: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_username: string | null;
  last_inbound_at: string | null;
  flow_name: string | null;
}

const STATUS: Record<Status, { label: string; cls: string; next?: { to: Status; label: string } }> = {
  new: { label: 'Novo', cls: 'badge-danger', next: { to: 'preparing', label: 'Começar preparo' } },
  preparing: { label: 'Em preparo', cls: 'badge-warning', next: { to: 'delivering', label: 'Saiu para entrega' } },
  delivering: { label: 'Saiu para entrega', cls: 'badge-primary', next: { to: 'done', label: 'Concluir' } },
  done: { label: 'Concluído', cls: 'badge-success' },
  cancelled: { label: 'Cancelado', cls: '' },
};

const PAYMENT: Record<Order['payment_status'], { label: string; cls: string } | null> = {
  none: null,
  pending: { label: 'Pix pendente', cls: 'badge-warning' },
  paid: { label: 'Pago', cls: 'badge-success' },
  expired: { label: 'Pix expirou', cls: 'badge-danger' },
  refunded: { label: 'Estornado', cls: '' },
};

const LABELS: Record<string, string> = {
  nome: 'Nome',
  endereco: 'Endereço',
  telefone: 'Telefone',
  pagamento: 'Pagamento',
  observacao: 'Observação',
  observacoes: 'Observações',
  pedido: 'Pedido',
  bairro: 'Bairro',
  referencia: 'Referência',
  troco: 'Troco',
  email: 'E-mail',
};
export const prettyLabel = (k: string) => LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
export const money = (c: number | null) => (c === null ? '' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

/** Telefone dos detalhes → link do WhatsApp (assume Brasil se vier sem DDI). */
function whatsappOf(o: Order): string | null {
  const d = o.details.find((x) => /telefone|celular|whats|fone/i.test(x.label)) ?? o.details.find((x) => /^\D*\d[\d\s().-]{8,}$/.test(x.value));
  if (!d) return null;
  let n = d.value.replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return n.length >= 12 ? `https://wa.me/${n}` : null;
}

const TABS: { key: Status | 'all'; label: string }[] = [
  { key: 'new', label: 'Novos' },
  { key: 'preparing', label: 'Em preparo' },
  { key: 'delivering', label: 'Saiu para entrega' },
  { key: 'done', label: 'Concluídos' },
  { key: 'cancelled', label: 'Cancelados' },
  { key: 'all', label: 'Todos' },
];

export function Orders() {
  const { workspace } = useSession();
  const toast = useToast();
  const orders = useLoad(() => api<Order[]>('/app/orders'), [workspace?.id]);
  const [tab, setTab] = useState<Status | 'all'>('new');
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem('autoflow-orders-notify') !== '0';
    } catch {
      return true;
    }
  });
  const [notifPerm, setNotifPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  useEffect(() => {
    const t = setInterval(() => orders.reload(), 8000);
    return () => clearInterval(t);
  }, [orders.reload]);

  const list = orders.data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length };
    for (const o of list) c[o.status] = (c[o.status] ?? 0) + 1;
    return c;
  }, [list]);
  const shown = tab === 'all' ? list : list.filter((o) => o.status === tab);

  async function move(o: Order, to: Status) {
    if (to === 'cancelled' && !confirm(`Cancelar o pedido #${o.number}?`)) return;
    try {
      const r = await api<{ notified: boolean | null; warning: string | null }>(`/app/orders/${o.id}`, { method: 'PATCH', body: { status: to, notify } });
      toast(r.warning ?? `Pedido #${o.number}: ${STATUS[to].label.toLowerCase()}${r.notified ? ' · cliente avisado no Direct' : ''}`, Boolean(r.warning));
      orders.reload();
      window.dispatchEvent(new Event('autoflow:orders-changed'));
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  function toggleNotify(v: boolean) {
    setNotify(v);
    try {
      localStorage.setItem('autoflow-orders-notify', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Pedidos</h1>
          <p className="muted">Pedidos feitos pelo Direct. Chegam aqui na hora, com som de aviso.</p>
        </div>
        <div className="row wrap">
          <label className="checkbox small">
            <input type="checkbox" checked={notify} onChange={(e) => toggleNotify(e.target.checked)} /> Avisar o cliente no Direct ao mudar o status
          </label>
          {notifPerm === 'default' && (
            <button className="btn btn-sm" onClick={async () => setNotifPerm(await Notification.requestPermission())}>
              🔔 Ativar avisos no computador
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
            {counts[t.key] ? <span className={`badge ${t.key === 'new' ? 'badge-danger' : ''}`} style={{ marginLeft: 6 }}>{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      <ErrorBox error={orders.error} />
      {orders.loading && !orders.data ? (
        <Loading />
      ) : !shown.length ? (
        <div className="card">
          <Empty
            title={list.length ? 'Nada por aqui' : 'Nenhum pedido ainda'}
            text={
              list.length
                ? 'Nenhum pedido com esse status.'
                : 'Use a ação “Registrar pedido” num fluxo (ou o modelo de restaurante). Cada pedido feito no Direct aparece aqui com todos os dados.'
            }
          />
        </div>
      ) : (
        <div className="orders-grid">
          {shown.map((o) => (
            <OrderCard key={o.id} o={o} onMove={move} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ o, onMove }: { o: Order; onMove: (o: Order, to: Status) => void }) {
  const st = STATUS[o.status];
  const pay = PAYMENT[o.payment_status];
  const wa = whatsappOf(o);
  return (
    <div className={`card order-card st-${o.status}`}>
      <div className="order-head">
        <b style={{ fontSize: 17 }}>#{o.number}</b>
        <span className={`badge ${st.cls}`}>{st.label}</span>
        {pay && <span className={`badge ${pay.cls}`}>{pay.label}</span>}
        <span className="spacer" />
        <span className="muted small">{formatDateTime(o.created_at)}</span>
      </div>
      <div className="order-body">
        <div className="small">
          {o.contact_name || o.contact_username ? (
            <>
              <b>{o.contact_name ?? ''}</b> {o.contact_username && <span className="muted">@{o.contact_username}</span>}
            </>
          ) : (
            <span className="muted">Cliente</span>
          )}
        </div>
        {o.summary && <div className="order-summary">{o.summary}</div>}
        {o.details.length > 0 && (
          <dl className="order-details">
            {o.details.map((d, i) => (
              <div key={i}>
                <dt>{prettyLabel(d.label)}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {o.total_cents !== null && (
          <div className="row-between">
            <span className="muted small">Total</span>
            <b>{money(o.total_cents)}</b>
          </div>
        )}
      </div>
      <div className="order-actions">
        {st.next && (
          <button className="btn btn-primary btn-sm" onClick={() => onMove(o, st.next!.to)}>
            {st.next.label}
          </button>
        )}
        {o.contact_id && (
          <Link className="btn btn-sm" to={`/inbox/${o.contact_id}`}>
            <Icon name="inbox" size={15} /> Conversa
          </Link>
        )}
        {wa && (
          <a className="btn btn-sm" href={wa} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        )}
        <button className="btn btn-sm" onClick={() => printOrder(o)}>
          Imprimir
        </button>
        {o.status !== 'done' && o.status !== 'cancelled' && (
          <button className="btn btn-sm btn-ghost" onClick={() => onMove(o, 'cancelled')}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Comanda para impressora térmica/comum. */
function printOrder(o: Order) {
  const w = window.open('', '_blank', 'width=380,height=600');
  if (!w) return;
  const rows = o.details.map((d) => `<p><b>${esc(prettyLabel(d.label))}:</b> ${esc(d.value)}</p>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido #${o.number}</title>
<style>body{font:14px/1.4 monospace;margin:12px;max-width:300px}h1{font-size:20px;margin:0 0 4px}hr{border:0;border-top:1px dashed #000;margin:8px 0}p{margin:3px 0}pre{white-space:pre-wrap;font:inherit;margin:0}</style>
</head><body><h1>Pedido #${o.number}</h1><p>${esc(formatDateTime(o.created_at))}</p><hr>
<p><b>Cliente:</b> ${esc(o.contact_name ?? '')} ${o.contact_username ? '@' + esc(o.contact_username) : ''}</p>${rows}<hr>
<pre>${esc(o.summary)}</pre>${o.total_cents !== null ? `<hr><p><b>Total: ${esc(money(o.total_cents))}</b></p>` : ''}
${PAYMENT[o.payment_status] ? `<p>${esc(PAYMENT[o.payment_status]!.label)}</p>` : ''}
<script>window.onload=()=>{window.print();}</script></body></html>`);
  w.document.close();
}
