import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Empty, Icon, Loading, useToast } from '../components/ui';
import { api, formatDateTime, timeAgo } from '../lib/api';
import { followersOf, formatFollowers, INFLUENCER_MIN, isInfluencer, isVerified, visibleFields } from '../lib/profile';

interface Conv {
  id: string;
  username: string | null;
  name: string | null;
  bot_paused_until: string | null;
  last_inbound_at: string | null;
  closed: boolean;
  followers: string | null;
  verified: boolean | null;
  last_text: string | null;
  last_direction: string;
  last_source: string;
  last_at: string;
}

interface ContactDetail {
  id: string;
  username: string | null;
  name: string | null;
  bot_paused_until: string | null;
  last_inbound_at: string | null;
  closed_at: string | null;
  tags: string[];
  fields: Record<string, unknown>;
  messages: { id: string; direction: 'in' | 'out'; source: string; text: string | null; payload: any; created_at: string }[];
}

const paused = (iso: string | null) => Boolean(iso && new Date(iso) > new Date());
/** Fechada = marcada como fechada e o cliente não escreveu depois disso. */
const isClosed = (d: { closed_at: string | null; last_inbound_at: string | null }) =>
  Boolean(d.closed_at && (!d.last_inbound_at || new Date(d.last_inbound_at) <= new Date(d.closed_at)));

function messageText(m: ContactDetail['messages'][number]): string {
  if (m.text) return m.text;
  const p = m.payload ?? {};
  if (p.story_mention) return '📸 Marcou você num story';
  if (p.kind === 'image') return '🖼 Imagem';
  if (p.kind === 'file') return '📎 Arquivo PDF';
  if (p.kind === 'carousel') return `🗂 Carrossel (${p.cards?.length ?? 0} cartões)`;
  if (p.postback) return '🔘 Clicou num botão';
  return '(mensagem sem texto)';
}

export function Inbox() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'open' | 'human'>('all');
  const [list, setList] = useState<Conv[] | null>(null);
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Atualiza a lista e a conversa aberta a cada 4s
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const l = await api<Conv[]>(`/app/conversations?filter=${filter}`);
        if (alive) setList(l);
        if (id) {
          const d = await api<ContactDetail>(`/app/contacts/${id}`);
          if (alive) setDetail(d);
        }
      } catch {
        /* tenta de novo no próximo ciclo */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [filter, id]);

  useEffect(() => {
    if (!id) setDetail(null);
  }, [id]);

  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    }
  }, [detail]);

  async function send() {
    if (!id || !text.trim()) return;
    setSending(true);
    try {
      await api(`/app/contacts/${id}/messages`, { body: { text } });
      setText('');
      setDetail(await api<ContactDetail>(`/app/contacts/${id}`));
    } catch (e) {
      toast((e as Error).message, true);
    }
    setSending(false);
  }

  async function bot(action: 'pause-bot' | 'resume-bot') {
    await api(`/app/contacts/${id}/${action}`, { body: {} });
    setDetail(await api<ContactDetail>(`/app/contacts/${id}`));
    toast(action === 'pause-bot' ? 'Robô pausado para este contato' : 'Robô religado');
  }

  async function setClosed(close: boolean) {
    await api(`/app/contacts/${id}/${close ? 'close' : 'reopen'}`, { body: {} });
    setDetail(await api<ContactDetail>(`/app/contacts/${id}`));
    toast(close ? 'Conversa fechada. Se o cliente escrever de novo, ela reabre sozinha.' : 'Conversa reaberta');
  }

  const windowOpen = detail?.last_inbound_at ? Date.now() - new Date(detail.last_inbound_at).getTime() < 24 * 3600 * 1000 : false;

  return (
    <div className="inbox">
      <div className="inbox-list">
        <div style={{ padding: '14px 14px 0' }}>
          <h2>Inbox</h2>
          <div className="tabs" style={{ marginTop: 10, marginBottom: 0 }}>
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              Todas
            </button>
            <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>
              Abertas
            </button>
            <button className={filter === 'human' ? 'active' : ''} onClick={() => setFilter('human')}>
              Com atendente
            </button>
          </div>
        </div>
        {!list ? (
          <Loading />
        ) : !list.length ? (
          <Empty title="Nenhuma conversa" text={filter === 'human' ? 'Ninguém aguardando atendente.' : filter === 'open' ? 'Nenhuma conversa aberta. 🎉' : 'As mensagens do Instagram aparecem aqui.'} />
        ) : (
          list.map((c) => (
            <div key={c.id} className={`inbox-item ${c.id === id ? 'active' : ''}`} onClick={() => nav(`/inbox/${c.id}`)}>
              <div className="row-between">
                <b>
                  {c.username ? `@${c.username}` : (c.name ?? 'Contato')}
                  {(Number(c.followers ?? 0) >= INFLUENCER_MIN || c.verified) && (
                    <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Tem muitos seguidores ou selo de verificado">
                      ⭐ {c.followers ? formatFollowers(Number(c.followers)) : 'verificado'}
                    </span>
                  )}
                </b>
                <span className="muted small">{timeAgo(c.last_at)}</span>
              </div>
              <div className="row-between" style={{ marginTop: 3 }}>
                <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 210 }}>
                  {c.last_direction === 'out' ? (c.last_source === 'human' ? 'Você: ' : '🤖 ') : ''}
                  {c.last_text ?? '…'}
                </span>
                {paused(c.bot_paused_until) ? <span className="badge badge-warning">atendente</span> : c.closed && <span className="badge">✓ fechada</span>}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat">
        {!id ? (
          <div className="center" style={{ flex: 1 }}>
            <Empty title="Escolha uma conversa" text="Veja o que o robô respondeu e assuma quando precisar." />
          </div>
        ) : !detail ? (
          <Loading />
        ) : (
          <>
            <div className="chat-header row-between">
              <div>
                <b>{detail.username ? `@${detail.username}` : (detail.name ?? 'Contato')}</b>
                {detail.name && detail.username && <span className="muted"> · {detail.name}</span>}
                {followersOf(detail.fields) !== null && (
                  <span className={isInfluencer(detail.fields) ? 'badge badge-warning' : 'muted small'} style={{ marginLeft: 8 }}>
                    {isInfluencer(detail.fields) ? '⭐ ' : ''}
                    {formatFollowers(followersOf(detail.fields)!)} seguidores{isVerified(detail.fields) ? ' · verificado' : ''}
                  </span>
                )}
                <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
                  {detail.tags.map((t) => (
                    <span key={t} className="badge badge-primary">
                      {t}
                    </span>
                  ))}
                  {visibleFields(detail.fields).map(([k, v]) => (
                    <span key={k} className="badge">
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flex: 'none' }}>
                {isClosed(detail) ? (
                  <button className="btn btn-sm" onClick={() => setClosed(false)} title="Volta a aparecer em Abertas">
                    Reabrir
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => setClosed(true)} title="Tira de Abertas. Se o cliente escrever de novo, ela reabre sozinha.">
                    <Icon name="check" /> Fechar conversa
                  </button>
                )}
                {paused(detail.bot_paused_until) ? (
                  <button className="btn btn-sm" onClick={() => bot('resume-bot')}>
                    <Icon name="play" /> Religar robô
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => bot('pause-bot')}>
                    <Icon name="pause" /> Assumir conversa
                  </button>
                )}
              </div>
            </div>
            <div className="chat-body" ref={bodyRef}>
              {detail.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.direction} ${m.source === 'human' ? 'human' : ''}`}>
                  {m.source === 'comment' && <div className="small" style={{ opacity: 0.7 }}>💬 Comentário</div>}
                  {messageText(m)}
                  {m.payload?.kind === 'buttons' && (
                    <div className="small" style={{ opacity: 0.85, marginTop: 4 }}>
                      {m.payload.buttons.map((b: any) => `[${b.title}]`).join(' ')}
                    </div>
                  )}
                  <div className="bubble-meta">
                    {m.direction === 'out' ? (m.source === 'human' ? 'Atendente' : 'Robô') : 'Cliente'} · {formatDateTime(m.created_at)}
                  </div>
                </div>
              ))}
            </div>
            {paused(detail.bot_paused_until) && (
              <div className="alert alert-warning" style={{ margin: '0 18px 8px', borderRadius: 8 }}>
                Robô pausado até {formatDateTime(detail.bot_paused_until)}. Você está no atendimento.
              </div>
            )}
            <div className="chat-input">
              <input
                className="input"
                placeholder={windowOpen ? 'Responder como atendente… (pausa o robô)' : 'Fora da janela de 24h — o Instagram só deixa responder depois que o cliente escrever de novo'}
                value={text}
                disabled={!windowOpen}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
              />
              <button className="btn btn-primary" onClick={send} disabled={sending || !text.trim() || !windowOpen}>
                <Icon name="send" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
