import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, formatDateTime } from '../lib/api';
import { describeAutomation, isEditable, POST_STATUS, postDate, postTitle, type Post } from '../lib/posts';
import { useSession } from '../lib/session';

type TType = 'comment' | 'dm_keyword' | 'story_mention' | 'postback' | 'default_reply';

interface Trigger {
  id: string;
  flow_id: string;
  flow_name: string;
  flow_status: string;
  ig_account_id: string | null;
  type: TType;
  config: any;
  priority: number;
  enabled: boolean;
}

const TYPES: Record<TType, { label: string; desc: string; icon: string }> = {
  dm_keyword: { label: 'Palavra-chave na DM', desc: 'Quando o cliente manda uma mensagem com certas palavras.', icon: '💬' },
  comment: { label: 'Comentário em post', desc: 'Quando alguém comenta — responde em público e chama no direct.', icon: '🗨' },
  story_mention: { label: 'Menção em story', desc: 'Quando alguém marca a conta num story.', icon: '📸' },
  default_reply: { label: 'Resposta padrão', desc: 'Quando nenhuma outra regra entendeu a mensagem.', icon: '🤖' },
  postback: { label: 'Botão do menu / ice breaker', desc: 'Payload personalizado de botões do perfil.', icon: '🔘' },
};

const MATCH: Record<string, string> = { contains: 'contém', exact: 'é exatamente', starts_with: 'começa com' };

function describe(t: Trigger): string {
  const c = t.config;
  switch (t.type) {
    case 'dm_keyword':
      return `Mensagem ${MATCH[c.match] ?? 'contém'}: ${c.keywords.join(', ')}`;
    case 'comment':
      return `${c.media_id ? 'Num post específico' : 'Em qualquer post'}${c.keywords?.length ? ` · comentário ${MATCH[c.match] ?? 'contém'}: ${c.keywords.join(', ')}` : ' · qualquer comentário'}${c.once_per_contact ? ' · 1 vez por pessoa' : ''}`;
    case 'default_reply':
      return `No máximo 1 vez a cada ${c.cooldown_minutes} min por pessoa`;
    case 'postback':
      return `Payload: ${c.payload}`;
    default:
      return '';
  }
}

export function Triggers() {
  const { workspace } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api<Trigger[]>('/app/triggers'), [workspace?.id]);
  const flows = useLoad(() => api<{ id: string; name: string; status: string }[]>('/app/flows'), [workspace?.id]);
  const [editing, setEditing] = useState<Partial<Trigger> | null>(null);
  const posts = useLoad(() => api<Post[]>('/app/posts'), [workspace?.id]);
  const pending = (posts.data ?? []).filter((p) => p.automation && (isEditable(p) || p.status === 'publishing') && p.status !== 'cancelled');

  async function unlinkPost(p: Post) {
    if (!confirm('Tirar a automação desta publicação? O post continua agendado.')) return;
    try {
      await api(`/app/posts/${p.id}/automation`, { method: 'PUT', body: { automation: null } });
      toast('Automação removida');
      posts.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  async function toggle(t: Trigger) {
    await api(`/app/triggers/${t.id}`, { method: 'PUT', body: { ...pick(t), enabled: !t.enabled } });
    reload();
  }
  async function remove(t: Trigger) {
    if (!confirm('Excluir este gatilho?')) return;
    await api(`/app/triggers/${t.id}`, { method: 'DELETE' });
    toast('Gatilho excluído');
    reload();
  }

  const groups = (Object.keys(TYPES) as TType[]).map((type) => ({ type, items: (data ?? []).filter((t) => t.type === type) })).filter((g) => g.items.length);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Gatilhos</h1>
          <p className="muted">O que faz cada fluxo começar. Mensagens de um cliente que já está no meio de um fluxo continuam nele.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ type: 'dm_keyword', config: { keywords: [], match: 'contains' }, priority: 0, enabled: true })}>
          <Icon name="plus" /> Novo gatilho
        </button>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : !data?.length && !pending.length ? (
        <div className="card">
          <Empty title="Nenhum gatilho" text="Crie um gatilho para ligar um fluxo a palavras-chave, comentários ou stories." />
        </div>
      ) : (
        <div className="stack">
          {pending.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3>🗓 Aguardando publicação</h3>
                <span className="muted small">Viram gatilhos de comentário assim que o post sair.</span>
              </div>
              <table className="table">
                <tbody>
                  {pending.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>
                          {describeAutomation(p.automation!)} · em "{postTitle(p)}"
                        </div>
                        <div className="muted small">
                          → <Link to={`/fluxos/${p.automation!.flow_id}`}>{p.flow_name ?? 'fluxo removido'}</Link>
                          {p.flow_status !== 'published' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>fluxo não publicado</span>}
                          <span style={{ marginLeft: 6 }}>
                            · <span className={`badge ${POST_STATUS[p.status].cls}`}>{POST_STATUS[p.status].label}</span> {formatDateTime(postDate(p).toISOString())}
                          </span>
                        </div>
                      </td>
                      <td style={{ width: 230, textAlign: 'right' }}>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <Link className="btn btn-sm" to="/publicacoes">
                            Ver publicação
                          </Link>
                          {isEditable(p) && (
                            <button className="btn btn-sm btn-danger btn-ghost" onClick={() => unlinkPost(p)} aria-label="Remover automação">
                              <Icon name="trash" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {groups.map((g) => (
            <div className="card" key={g.type}>
              <div className="card-header">
                <h3>
                  {TYPES[g.type].icon} {TYPES[g.type].label}
                </h3>
                <span className="muted small">{TYPES[g.type].desc}</span>
              </div>
              <table className="table">
                <tbody>
                  {g.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{describe(t) || TYPES[t.type].label}</div>
                        <div className="muted small">
                          → <Link to={`/fluxos/${t.flow_id}`}>{t.flow_name}</Link>
                          {t.flow_status !== 'published' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>fluxo não publicado</span>}
                          {t.priority !== 0 && <span style={{ marginLeft: 6 }}>· prioridade {t.priority}</span>}
                        </div>
                      </td>
                      <td style={{ width: 230, textAlign: 'right' }}>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <button className={`btn btn-sm ${t.enabled ? '' : 'btn-primary'}`} onClick={() => toggle(t)}>
                            {t.enabled ? 'Pausar' : 'Ativar'}
                          </button>
                          <button className="btn btn-sm" onClick={() => setEditing(t)}>
                            Editar
                          </button>
                          <button className="btn btn-sm btn-danger btn-ghost" onClick={() => remove(t)}>
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TriggerModal
          initial={editing}
          flows={(flows.data ?? []).filter((f) => f.status !== 'archived')}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            reload();
            posts.reload();
            toast(msg ?? 'Gatilho salvo');
          }}
        />
      )}
    </div>
  );
}

function pick(t: Partial<Trigger>) {
  return { flow_id: t.flow_id, ig_account_id: t.ig_account_id ?? null, type: t.type, config: t.config, priority: t.priority ?? 0, enabled: t.enabled ?? true };
}

function TriggerModal({ initial, flows, onClose, onSaved }: { initial: Partial<Trigger>; flows: { id: string; name: string }[]; onClose: () => void; onSaved: (msg?: string) => void }) {
  const [t, setT] = useState<Partial<Trigger>>({ ...initial, flow_id: initial.flow_id ?? flows[0]?.id });
  const [kw, setKw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [schedPicker, setSchedPicker] = useState(false);
  const [scheduled, setScheduled] = useState<Post | null>(null); // post agendado (ainda sem media_id)
  const c = t.config ?? {};
  const setC = (patch: any) => setT({ ...t, config: { ...c, ...patch } });

  function setType(type: TType) {
    const defaults: Record<TType, any> = {
      dm_keyword: { keywords: [], match: 'contains' },
      comment: { media_id: null, keywords: [], match: 'contains', public_replies: ['Te chamei no direct! 📩'], once_per_contact: false },
      story_mention: {},
      default_reply: { cooldown_minutes: 120 },
      postback: { payload: '' },
    };
    setT({ ...t, type, config: defaults[type] });
  }

  function addKeyword() {
    const k = kw.trim();
    if (!k) return;
    setC({ keywords: [...(c.keywords ?? []), k] });
    setKw('');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const cfg = { ...c };
      if (kw.trim()) cfg.keywords = [...(cfg.keywords ?? []), kw.trim()];
      if (scheduled && t.type === 'comment') {
        // Fica guardado no post; vira gatilho quando ele for publicado
        await api(`/app/posts/${scheduled.id}/automation`, {
          method: 'PUT',
          body: {
            automation: {
              flow_id: t.flow_id,
              keywords: cfg.keywords ?? [],
              match: cfg.match ?? 'contains',
              public_replies: (cfg.public_replies ?? []).map((r: string) => r.trim()).filter(Boolean),
              once_per_contact: Boolean(cfg.once_per_contact),
            },
          },
        });
        onSaved('Automação salva — o gatilho é criado quando o post sair');
        return;
      }
      const body = pick({ ...t, config: cfg });
      if (t.id) await api(`/app/triggers/${t.id}`, { method: 'PUT', body });
      else await api('/app/triggers', { body });
      onSaved();
    } catch (e: any) {
      setError(e.body?.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(' · ') || e.message);
    }
    setBusy(false);
  }

  return (
    <Modal
      title={t.id ? 'Editar gatilho' : 'Novo gatilho'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !t.flow_id}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </>
      }
    >
      <div className="stack">
        {!t.id && (
          <div className="grid grid-2">
            {(Object.keys(TYPES) as TType[]).map((k) => (
              <label key={k} className="card checkbox" style={{ padding: 12, borderColor: t.type === k ? 'var(--primary)' : undefined }}>
                <input type="radio" checked={t.type === k} onChange={() => setType(k)} />
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {TYPES[k].icon} {TYPES[k].label}
                  </div>
                  <div className="muted small">{TYPES[k].desc}</div>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="field">
          <label className="label">Inicia o fluxo</label>
          {flows.length ? (
            <select className="select" value={t.flow_id} onChange={(e) => setT({ ...t, flow_id: e.target.value })}>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="alert alert-warning">
              Crie um fluxo antes. <Link to="/fluxos">Ir para fluxos</Link>
            </div>
          )}
        </div>

        {(t.type === 'dm_keyword' || t.type === 'comment') && (
          <>
            {t.type === 'comment' && (
              <div className="field">
                <label className="label">Em qual post?</label>
                <div className="row wrap">
                  <span className="badge">
                    {scheduled
                      ? `Agendado: ${postTitle(scheduled)} (${formatDateTime(scheduled.scheduled_at)})`
                      : c.media_id
                        ? `Post ${String(c.media_id).slice(-6)}`
                        : 'Qualquer post ou reel'}
                  </span>
                  <button className="btn btn-sm" onClick={() => setPicker(true)}>
                    Post publicado
                  </button>
                  {!t.id && (
                    <button className="btn btn-sm" onClick={() => setSchedPicker(true)}>
                      Post agendado
                    </button>
                  )}
                  {(c.media_id || scheduled) && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setScheduled(null);
                        setC({ media_id: null });
                      }}
                    >
                      Qualquer post
                    </button>
                  )}
                </div>
                {scheduled && <span className="hint">A automação fica guardada no post e vira gatilho assim que ele for publicado.</span>}
              </div>
            )}
            <div className="field">
              <label className="label">Palavras-chave {t.type === 'comment' && '(vazio = qualquer comentário)'}</label>
              <div className="row wrap" style={{ marginBottom: 6, gap: 6 }}>
                {(c.keywords ?? []).map((k: string, i: number) => (
                  <span className="chip" key={i}>
                    {k}
                    <button onClick={() => setC({ keywords: c.keywords.filter((_: string, j: number) => j !== i) })}>×</button>
                  </span>
                ))}
              </div>
              <div className="row">
                <select className="select" style={{ maxWidth: 170 }} value={c.match ?? 'contains'} onChange={(e) => setC({ match: e.target.value })}>
                  <option value="contains">Contém</option>
                  <option value="exact">É exatamente</option>
                  <option value="starts_with">Começa com</option>
                </select>
                <input
                  className="input"
                  placeholder="Digite e aperte Enter (ex.: cardápio)"
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
                />
                <button className="btn" onClick={addKeyword}>
                  Adicionar
                </button>
              </div>
              <span className="hint">Não diferencia maiúsculas nem acentos e aceita pequenos erros de digitação.</span>
            </div>
          </>
        )}

        {t.type === 'comment' && (
          <>
            <div className="field">
              <label className="label">Respostas públicas no comentário (sorteia uma)</label>
              {(c.public_replies ?? []).map((r: string, i: number) => (
                <div className="row" key={i} style={{ marginBottom: 6 }}>
                  <input
                    className="input"
                    value={r}
                    onChange={(e) => setC({ public_replies: c.public_replies.map((x: string, j: number) => (j === i ? e.target.value : x)) })}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => setC({ public_replies: c.public_replies.filter((_: string, j: number) => j !== i) })}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
              <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setC({ public_replies: [...(c.public_replies ?? []), ''] })}>
                <Icon name="plus" /> Resposta
              </button>
              <span className="hint">Deixe sem nenhuma para não responder em público.</span>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={Boolean(c.once_per_contact)} onChange={(e) => setC({ once_per_contact: e.target.checked })} />
              Disparar só uma vez por pessoa
            </label>
          </>
        )}

        {t.type === 'default_reply' && (
          <div className="field">
            <label className="label">Intervalo mínimo entre respostas para a mesma pessoa (minutos)</label>
            <input className="input" type="number" min={0} value={c.cooldown_minutes ?? 120} onChange={(e) => setC({ cooldown_minutes: Number(e.target.value) })} style={{ maxWidth: 160 }} />
          </div>
        )}

        {t.type === 'postback' && (
          <div className="field">
            <label className="label">Payload</label>
            <input className="input mono" value={c.payload ?? ''} onChange={(e) => setC({ payload: e.target.value })} />
          </div>
        )}

        <div className="field">
          <label className="label">Prioridade</label>
          <input className="input" type="number" value={t.priority ?? 0} onChange={(e) => setT({ ...t, priority: Number(e.target.value) })} style={{ maxWidth: 120 }} />
          <span className="hint">Quando dois gatilhos combinam com a mesma mensagem, vale o de maior prioridade.</span>
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
      </div>

      {picker && <MediaPicker onClose={() => setPicker(false)} onPick={(id) => (setScheduled(null), setC({ media_id: id }), setPicker(false))} selected={c.media_id} />}
      {schedPicker && (
        <ScheduledPicker
          onClose={() => setSchedPicker(false)}
          onPick={(p) => {
            setScheduled(p);
            setC({ media_id: null });
            setSchedPicker(false);
          }}
        />
      )}
    </Modal>
  );
}

function MediaPicker({ onClose, onPick, selected }: { onClose: () => void; onPick: (id: string) => void; selected?: string | null }) {
  const accounts = useLoad(() => api<{ id: string; username: string; status: string }[]>('/app/accounts'), []);
  const acc = accounts.data?.find((a) => a.status === 'active');
  const media = useLoad(
    () => (acc ? api<{ id: string; caption?: string; media_url?: string; thumbnail_url?: string; media_type: string }[]>(`/app/accounts/${acc.id}/media`) : Promise.resolve([])),
    [acc?.id],
  );
  return (
    <Modal title="Escolher post" onClose={onClose} wide>
      {accounts.loading || media.loading ? (
        <Loading />
      ) : !acc ? (
        <div className="alert alert-warning">Conecte uma conta do Instagram primeiro.</div>
      ) : (
        <>
          <ErrorBox error={media.error} />
          <div className="media-grid">
            {media.data?.map((m) => (
              <div key={m.id} className={`media-item ${selected === m.id ? 'selected' : ''}`} onClick={() => onPick(m.id)} title={m.caption}>
                {(m.thumbnail_url || m.media_url) && <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" />}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function ScheduledPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: Post) => void }) {
  const posts = useLoad(() => api<Post[]>('/app/posts'), []);
  const list = (posts.data ?? []).filter(isEditable).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
  return (
    <Modal title="Escolher post agendado" onClose={onClose} wide>
      {posts.loading && !posts.data ? (
        <Loading />
      ) : !list.length ? (
        <Empty title="Nenhum post agendado" text="Agende um post ou Reels em Publicações para ligar uma automação a ele." action={<Link className="btn btn-primary" to="/publicacoes">Ir para Publicações</Link>} />
      ) : (
        <div className="stack-sm">
          <ErrorBox error={posts.error} />
          {list.map((p) => (
            <button key={p.id} className="pick-row" onClick={() => onPick(p)}>
              {p.media[0]?.kind === 'video' ? (
                <video src={`${p.media[0].url}#t=0.5`} muted preload="metadata" />
              ) : (
                <img src={p.media[0]?.url} alt="" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 550 }}>{postTitle(p)}</div>
                <div className="muted small">
                  {p.media_type === 'REELS' ? 'Reels' : 'Imagem'} · @{p.username} · {formatDateTime(p.scheduled_at)} · {POST_STATUS[p.status].label}
                  {p.automation ? ` · já tem automação (${p.flow_name ?? 'fluxo'}) — será substituída` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
