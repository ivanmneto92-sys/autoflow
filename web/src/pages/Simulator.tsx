import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, Loading, useToast } from '../components/ui';
import { api } from '../lib/api';

interface Msg {
  id: string;
  direction: 'in' | 'out';
  source: string;
  text: string | null;
  payload: any;
  created_at: string;
}
interface SimState {
  contact: { id: string; tags: string[]; fields: Record<string, unknown>; bot_paused_until: string | null } | null;
  messages: Msg[];
  session: { status: string; current_node_id: string | null; flow_name: string } | null;
}

const STATUS: Record<string, string> = {
  running: 'Executando',
  waiting_input: 'Esperando a resposta do cliente',
  waiting_delay: 'Em atraso (aguardando o tempo)',
  waiting_window: 'Esperando o cliente escrever (janela de 24h)',
  completed: 'Fluxo concluído',
  failed: 'Fluxo com erro',
  cancelled: 'Fluxo interrompido',
};

type SendBody =
  | { type: 'text'; text: string }
  | { type: 'click'; payload: string; title: string }
  | { type: 'quick_reply'; payload: string; title: string }
  | { type: 'comment'; text: string; media_id?: string }
  | { type: 'story_mention' }
  | { type: 'story_reply'; text: string }
  | { type: 'ref'; ref: string }
  | { type: 'ad'; text: string; ad_id?: string };

export function Simulator() {
  const toast = useToast();
  const [st, setSt] = useState<SimState | null>(null);
  const [text, setText] = useState('');
  const [comment, setComment] = useState('');
  const [storyText, setStoryText] = useState('');
  const [ref, setRef] = useState('');
  const [adText, setAdText] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = async () => setSt(await api<SimState>('/app/simulator'));
  useEffect(() => {
    load().catch((e) => toast(e.message, true));
  }, []);

  // Enquanto houver um atraso agendado, atualiza sozinho
  useEffect(() => {
    if (st?.session?.status !== 'waiting_delay') return;
    const t = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [st?.session?.status]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [st?.messages.length]);

  async function send(body: SendBody) {
    setBusy(true);
    try {
      setSt(await api<SimState>('/app/simulator/send', { body }));
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  async function reset() {
    setSt(await api<SimState>('/app/simulator/reset', { body: {} }));
    toast('Conversa reiniciada. Você agora é um contato novo.');
  }

  const paused = st?.contact?.bot_paused_until && new Date(st.contact.bot_paused_until) > new Date();
  // Mensagem com botões encerra a sessão, mas o fluxo continua quando o cliente clica
  const lastOut = st?.messages.at(-1);
  const waitingClick =
    st?.session?.status === 'completed' &&
    lastOut?.direction === 'out' &&
    Boolean(lastOut.payload?.buttons?.some((b: any) => b.type === 'postback') || lastOut.payload?.quickReplies?.length || lastOut.payload?.cards?.some((c: any) => c.buttons?.some((b: any) => b.type === 'postback')));
  const statusLabel = waitingClick ? 'Esperando o cliente escolher uma opção' : st?.session ? (STATUS[st.session.status] ?? st.session.status) : '';

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="page-header">
        <div>
          <h1>Simulador</h1>
          <p className="muted">
            Converse com o robô como se fosse um cliente no Instagram. Usa os fluxos e gatilhos <b>publicados</b>, sem enviar nada para a Meta.
          </p>
        </div>
        <button className="btn" onClick={reset}>
          <Icon name="refresh" /> Reiniciar conversa
        </button>
      </div>

      <div className="sim-grid">
        <div className="sim-phone card">
          <div className="sim-phone-head">
            <div className="sim-avatar">IG</div>
            <div>
              <b>Seu negócio</b>
              <div className="muted small">conversa simulada · você é o cliente</div>
            </div>
          </div>
          <div className="sim-body" ref={bodyRef}>
            {!st ? (
              <Loading />
            ) : !st.messages.length ? (
              <div className="muted small" style={{ textAlign: 'center', marginTop: 40 }}>
                Mande uma mensagem (ex.: <b>oi</b> ou <b>cardápio</b>) ou simule um comentário ao lado.
              </div>
            ) : (
              st.messages.map((m) => <Bubble key={m.id} m={m} onSend={send} disabled={busy} />)
            )}
          </div>
          <form
            className="sim-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              send({ type: 'text', text });
              setText('');
            }}
          >
            <input className="input" placeholder="Mensagem…" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} autoFocus />
            <button className="btn btn-primary" disabled={busy || !text.trim()}>
              <Icon name="send" />
            </button>
          </form>
        </div>

        <div className="stack">
          <div className="card card-body stack">
            <h3>O que está acontecendo</h3>
            {st?.session ? (
              <div className="stack-sm">
                <div>
                  <span className="muted small">Fluxo: </span>
                  <b>{st.session.flow_name}</b>
                </div>
                <div>
                  <span className="muted small">Situação: </span>
                  <span className={`badge ${st.session.status === 'failed' ? 'badge-danger' : st.session.status === 'completed' && !waitingClick ? 'badge-success' : 'badge-primary'}`}>
                    {statusLabel}
                  </span>
                </div>
                {st.session.current_node_id && !waitingClick && st.session.status !== 'completed' && (
                  <div>
                    <span className="muted small">Nó atual: </span>
                    <span className="mono">{st.session.current_node_id}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="muted">Nenhum fluxo iniciado ainda.</p>
            )}
            {paused && <div className="alert alert-warning">Robô pausado para este contato (atendimento humano). Reinicie a conversa para testar de novo.</div>}
            <div>
              <div className="label">Tags</div>
              <div className="row wrap" style={{ gap: 4 }}>
                {st?.contact?.tags.length ? st.contact.tags.map((t) => <span key={t} className="badge badge-primary">{t}</span>) : <span className="muted small">nenhuma</span>}
              </div>
            </div>
            <div>
              <div className="label">Dados coletados</div>
              {st?.contact && Object.keys(st.contact.fields).length ? (
                <table className="table">
                  <tbody>
                    {Object.entries(st.contact.fields).map(([k, v]) => (
                      <tr key={k}>
                        <td className="mono" style={{ padding: '6px 0' }}>{k}</td>
                        <td style={{ padding: '6px 0' }}>{String(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <span className="muted small">nenhum</span>
              )}
            </div>
          </div>

          <div className="card card-body stack">
            <h3>Simular outros eventos</h3>
            <div className="field">
              <label className="label">Comentário num post</label>
              <div className="row">
                <input className="input" placeholder="ex.: eu quero o cardápio" value={comment} onChange={(e) => setComment(e.target.value)} />
                <button
                  className="btn"
                  disabled={busy || !comment.trim()}
                  onClick={() => {
                    send({ type: 'comment', text: comment });
                    setComment('');
                  }}
                >
                  Comentar
                </button>
              </div>
              <span className="hint">Dispara gatilhos de comentário configurados para "qualquer post".</span>
            </div>
            <button className="btn" disabled={busy} onClick={() => send({ type: 'story_mention' })}>
              📸 Marcar o perfil num story
            </button>
            <SimField
              label="Responder um story"
              placeholder="ex.: quero!"
              value={storyText}
              onChange={setStoryText}
              button="Responder"
              disabled={busy}
              onSend={() => (send({ type: 'story_reply', text: storyText }), setStoryText(''))}
            />
            <SimField
              label="Abrir link ig.me com ref"
              placeholder="ex.: cardapio"
              value={ref}
              onChange={setRef}
              button="Abrir"
              disabled={busy}
              onSend={() => (send({ type: 'ref', ref }), setRef(''))}
              hint="Dispara gatilhos de “Link do Direct”."
            />
            <SimField
              label="Mensagem vinda de anúncio"
              placeholder="ex.: Olá, vi o anúncio"
              value={adText}
              onChange={setAdText}
              button="Enviar"
              disabled={busy}
              onSend={() => (send({ type: 'ad', text: adText }), setAdText(''))}
              hint="Dispara gatilhos de “Clique em anúncio” (qualquer anúncio)."
            />
          </div>

          <div className="alert alert-info small">
            O simulador usa só o que está <b>publicado</b>. Mudou um fluxo? Clique em <b>Publicar</b> no editor e teste de novo. Gatilhos e fluxos ficam em{' '}
            <Link to="/gatilhos">Gatilhos</Link> e <Link to="/fluxos">Fluxos</Link>.
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, onSend, disabled }: { m: Msg; onSend: (b: SendBody) => void; disabled: boolean }) {
  const p = m.payload ?? {};
  if (m.direction === 'in') {
    let text = m.text ?? '';
    if (m.source === 'comment') text = `💬 Comentou: ${m.text}`;
    else if (p.postback) text = `🔘 ${m.text || 'Clicou num botão'}`;
    else if (p.quick_reply) text = `⚡ ${m.text}`;
    else if (p.story_mention !== undefined) text = '📸 Marcou você num story';
    else if (p.referral && !m.text) text = `🔗 Abriu o link ig.me${p.referral.ref ? ` (ref: ${p.referral.ref})` : ''}`;
    else if (p.referral?.source === 'ADS') text = `📣 Veio do anúncio: ${m.text}`;
    else if (p.story_reply) text = `↩️ Respondeu ao story: ${m.text}`;
    return <div className="bubble out sim-me">{text || '…'}</div>;
  }

  // Mensagens do robô
  if (p.kind === 'image') {
    return (
      <div className="bubble in">
        <img src={p.url} alt="" style={{ maxWidth: 220, borderRadius: 8, display: 'block' }} />
      </div>
    );
  }
  if (p.kind === 'carousel') {
    return (
      <div className="sim-carousel">
        {p.cards.map((c: any, i: number) => (
          <div key={i} className="sim-card">
            {c.image_url && <img src={c.image_url} alt="" />}
            <div style={{ padding: '8px 10px' }}>
              <b>{c.title}</b>
              {c.subtitle && <div className="muted small">{c.subtitle}</div>}
            </div>
            {(c.buttons ?? []).map((b: any, j: number) => (
              <SimButton key={j} b={b} onSend={onSend} disabled={disabled} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bubble in" style={{ padding: p.kind === 'buttons' ? 0 : undefined, overflow: 'hidden' }}>
      <div style={p.kind === 'buttons' ? { padding: '9px 12px' } : undefined}>{m.text ?? p.text}</div>
      {p.kind === 'buttons' && p.buttons.map((b: any, j: number) => <SimButton key={j} b={b} onSend={onSend} disabled={disabled} />)}
      {p.kind === 'text' && p.quickReplies?.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
          {p.quickReplies.map((q: any, j: number) => (
            <button key={j} className="chip sim-qr" disabled={disabled} onClick={() => onSend({ type: 'quick_reply', payload: q.payload, title: q.title })}>
              {q.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SimButton({ b, onSend, disabled }: { b: any; onSend: (b: SendBody) => void; disabled: boolean }) {
  if (b.type === 'web_url')
    return (
      <a className="sim-btn" href={b.url} target="_blank" rel="noreferrer">
        🔗 {b.title}
      </a>
    );
  return (
    <button className="sim-btn" disabled={disabled} onClick={() => onSend({ type: 'click', payload: b.payload, title: b.title })}>
      {b.title}
    </button>
  );
}

function SimField(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  button: string;
  disabled: boolean;
  onSend: () => void;
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="label">{props.label}</label>
      <div className="row">
        <input className="input" placeholder={props.placeholder} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        <button className="btn" disabled={props.disabled || !props.value.trim()} onClick={props.onSend}>
          {props.button}
        </button>
      </div>
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}
