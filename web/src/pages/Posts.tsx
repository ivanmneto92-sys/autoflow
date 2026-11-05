import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, apiUpload, formatDateTime } from '../lib/api';
import { isEditable, MATCH_LABEL, POST_STATUS, postDate, postTitle, type Match, type MediaType, type Post } from '../lib/posts';
import { useSession } from '../lib/session';

interface Account {
  id: string;
  username: string;
  status: string;
}

interface Flow {
  id: string;
  name: string;
  status: string;
}

const STATUS = POST_STATUS;
const MATCH = MATCH_LABEL;

export function Posts() {
  const { workspace } = useSession();
  const toast = useToast();
  const posts = useLoad(() => api<Post[]>('/app/posts'), [workspace?.id]);
  const accounts = useLoad(() => api<Account[]>('/app/accounts'), [workspace?.id]);
  const flows = useLoad(() => api<Flow[]>('/app/flows'), [workspace?.id]);
  const [editing, setEditing] = useState<{ post: Post | null; when?: Date } | null>(null);
  const [view, setView] = useState<'lista' | 'calendario'>(() => {
    try {
      return localStorage.getItem('autoflow-posts-view') === 'calendario' ? 'calendario' : 'lista';
    } catch {
      return 'lista';
    }
  });
  function changeView(v: 'lista' | 'calendario') {
    setView(v);
    try {
      localStorage.setItem('autoflow-posts-view', v);
    } catch {
      /* ignore */
    }
  }
  function openFromCalendar(p: Post) {
    if (isEditable(p)) setEditing({ post: p });
    else if (p.permalink) window.open(p.permalink, '_blank', 'noreferrer');
    else toast(p.status === 'publishing' ? 'Publicando agora — aguarde um instante.' : 'Essa publicação não pode ser editada.');
  }
  const [perm, setPerm] = useState<Record<string, boolean | null>>({});

  const active = (accounts.data ?? []).filter((a) => a.status === 'active');

  // A conta deu permissão de publicar?
  useEffect(() => {
    for (const a of active)
      api<{ can_publish: boolean | null }>(`/app/accounts/${a.id}/publish-permission`)
        .then((r) => setPerm((p) => ({ ...p, [a.id]: r.can_publish })))
        .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data]);

  // Atualiza sozinho enquanto algo estiver publicando ou para sair nos próximos minutos
  const list = posts.data ?? [];
  const busy = list.some((p) => p.status === 'publishing' || (p.status === 'scheduled' && new Date(p.scheduled_at).getTime() < Date.now() + 10 * 60_000));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => posts.reload(), 10_000);
    return () => clearInterval(t);
  }, [busy, posts.reload]);

  const groups = useMemo(() => {
    const upcoming = list.filter((p) => p.status === 'scheduled' || p.status === 'publishing').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const failed = list.filter((p) => p.status === 'failed');
    const done = list.filter((p) => p.status === 'published' || p.status === 'cancelled');
    return { upcoming, failed, done };
  }, [list]);

  async function action(p: Post, what: 'publish-now' | 'cancel' | 'delete') {
    const ask = {
      'publish-now': 'Publicar agora no Instagram?',
      cancel: 'Cancelar esta publicação? Ela não vai sair no horário marcado.',
      delete:
        p.status === 'published'
          ? 'Remover do painel? O post continua no Instagram e a automação continua ativa em Gatilhos.'
          : 'Excluir esta publicação?',
    }[what];
    if (!confirm(ask)) return;
    try {
      if (what === 'delete') await api(`/app/posts/${p.id}`, { method: 'DELETE' });
      else await api(`/app/posts/${p.id}/${what}`, { body: {} });
      toast(what === 'publish-now' ? 'Vai publicar em instantes.' : what === 'cancel' ? 'Publicação cancelada.' : 'Removida.');
      posts.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  const edit = (p: Post) => setEditing({ post: p });
  const noPermission = active.filter((a) => perm[a.id] === false);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Publicações</h1>
          <p className="muted">Agende posts e Reels e já deixe a automação dos comentários pronta para cada um.</p>
        </div>
        <div className="row">
          <div className="seg">
            <button className={view === 'lista' ? 'active' : ''} onClick={() => changeView('lista')}>
              Lista
            </button>
            <button className={view === 'calendario' ? 'active' : ''} onClick={() => changeView('calendario')}>
              <Icon name="calendar" size={15} /> Calendário
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing({ post: null })} disabled={!active.length}>
            <Icon name="plus" /> Agendar publicação
          </button>
        </div>
      </div>

      {accounts.data && !active.length && (
        <div className="alert alert-warning" style={{ marginBottom: 14 }}>
          Conecte uma conta do Instagram primeiro em <Link to="/instagram">Instagram</Link>.
        </div>
      )}
      {noPermission.map((a) => (
        <div key={a.id} className="alert alert-warning" style={{ marginBottom: 14 }}>
          A conta <b>@{a.username}</b> ainda não deu permissão para <b>publicar conteúdo</b>. Reconecte a conta em{' '}
          <Link to="/instagram">Instagram</Link> e aceite essa permissão na tela da Meta — sem ela, as publicações vão falhar.
        </div>
      ))}

      <ErrorBox error={posts.error} />
      {posts.loading && !posts.data ? (
        <Loading />
      ) : view === 'calendario' ? (
        <Calendar posts={list} onPick={openFromCalendar} onNew={(when) => active.length && setEditing({ post: null, when })} />
      ) : !list.length ? (
        <div className="card">
          <Empty
            title="Nenhuma publicação ainda"
            text='Agende um post ou Reels e escolha uma palavra para o público comentar (ex.: "QUERO"). Quem comentar recebe o fluxo no Direct na hora.'
            action={
              active.length ? (
                <button className="btn btn-primary" onClick={() => setEditing({ post: null })}>
                  <Icon name="plus" /> Agendar a primeira
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="stack">
          <Section title="Próximas" posts={groups.upcoming} onEdit={edit} onAction={action} empty="Nada agendado." />
          {groups.failed.length > 0 && <Section title="Com erro" posts={groups.failed} onEdit={edit} onAction={action} />}
          {groups.done.length > 0 && <Section title="Publicadas e canceladas" posts={groups.done} onEdit={edit} onAction={action} />}
        </div>
      )}

      {editing && (
        <PostForm
          post={editing.post}
          initialWhen={editing.when}
          accounts={active}
          flows={flows.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            posts.reload();
          }}
        />
      )}
    </div>
  );
}

function Section({
  title,
  posts,
  onEdit,
  onAction,
  empty,
}: {
  title: string;
  posts: Post[];
  onEdit: (p: Post) => void;
  onAction: (p: Post, what: 'publish-now' | 'cancel' | 'delete') => void;
  empty?: string;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <span className="muted small">{posts.length}</span>
      </div>
      {!posts.length ? (
        <div className="card-body muted">{empty}</div>
      ) : (
        <div>
          {posts.map((p) => (
            <PostRow key={p.id} p={p} onEdit={onEdit} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

function PostRow({ p, onEdit, onAction }: { p: Post; onEdit: (p: Post) => void; onAction: (p: Post, what: 'publish-now' | 'cancel' | 'delete') => void }) {
  const st = STATUS[p.status];
  const editable = p.status === 'scheduled' || p.status === 'failed' || p.status === 'cancelled';
  const a = p.automation;
  return (
    <div className="post-row">
      <Thumb media={p.media[0]} />
      <div className="post-info">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className={`badge ${st.cls}`}>{st.label}</span>
          <span className="muted small">
            {p.media_type === 'REELS' ? 'Reels' : 'Imagem'} · @{p.username} ·{' '}
            {p.status === 'published' && p.published_at ? `publicada ${formatDateTime(p.published_at)}` : formatDateTime(p.scheduled_at)}
          </span>
        </div>
        <div className="post-caption">{p.caption || <span className="muted">Sem legenda</span>}</div>
        {a && (
          <div className="small">
            💬 {a.keywords.length ? `Comentário ${MATCH[a.match]} "${a.keywords.join('", "')}"` : 'Qualquer comentário'} → fluxo{' '}
            <b>{p.flow_name ?? 'removido'}</b>
            {p.flow_status === 'draft' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>rascunho — publique o fluxo</span>}
            {p.trigger_id && <span className="muted"> · gatilho ativo</span>}
          </div>
        )}
        {p.error && <div className={`alert ${p.status === 'published' ? 'alert-warning' : 'alert-danger'} small`}>{p.error}</div>}
      </div>
      <div className="post-actions">
        {p.permalink && (
          <a className="btn btn-sm" href={p.permalink} target="_blank" rel="noreferrer">
            <Icon name="external" size={15} /> Ver
          </a>
        )}
        {editable && (
          <button className="btn btn-sm" onClick={() => onEdit(p)}>
            <Icon name="edit" size={15} /> Editar
          </button>
        )}
        {editable && (
          <button className="btn btn-sm" onClick={() => onAction(p, 'publish-now')}>
            <Icon name="send" size={15} /> Publicar agora
          </button>
        )}
        {p.status === 'scheduled' && (
          <button className="btn btn-sm btn-ghost" onClick={() => onAction(p, 'cancel')}>
            Cancelar
          </button>
        )}
        {p.status !== 'publishing' && (
          <button className="btn btn-sm btn-ghost" onClick={() => onAction(p, 'delete')} aria-label="Excluir">
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function Thumb({ media, big }: { media?: { url: string; kind: 'image' | 'video' }; big?: boolean }) {
  const cls = big ? 'post-thumb big' : 'post-thumb';
  if (!media) return <div className={cls} />;
  return media.kind === 'video' ? (
    <video className={cls} src={`${media.url}#t=0.5`} muted playsInline preload="metadata" controls={big} />
  ) : (
    <img className={cls} src={media.url} alt="" />
  );
}

// ───────────── Calendário ─────────────

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function Calendar({ posts, onPick, onNew }: { posts: Post[]; onPick: (p: Post) => void; onNew: (when: Date) => void }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
    const list = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
    // corta a última semana se ela for toda do mês seguinte
    return list[35]!.getMonth() !== month.getMonth() ? list.slice(0, 35) : list;
  }, [month]);

  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts) {
      const k = dayKey(postDate(p));
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    for (const arr of m.values()) arr.sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
    return m;
  }, [posts]);

  const today = new Date();
  const todayKey = dayKey(today);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const raw = month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  function newAt(d: Date) {
    const when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0);
    if (when.getTime() < Date.now() + 15 * 60_000) {
      const soon = new Date(Date.now() + 60 * 60_000);
      soon.setMinutes(0, 0, 0);
      onNew(soon);
    } else onNew(when);
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="row">
          <button className="btn btn-sm" onClick={() => shift(-1)} aria-label="Mês anterior">
            <Icon name="back" size={15} />
          </button>
          <h2 style={{ minWidth: 170, textAlign: 'center' }}>{title}</h2>
          <button className="btn btn-sm" onClick={() => shift(1)} aria-label="Próximo mês">
            <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
              <Icon name="back" size={15} />
            </span>
          </button>
        </div>
        <button className="btn btn-sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>
          Hoje
        </button>
      </div>
      <div className="cal">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-head">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const k = dayKey(d);
          const items = byDay.get(k) ?? [];
          const past = d < startOfToday;
          const outside = d.getMonth() !== month.getMonth();
          return (
            <div
              key={k}
              className={`cal-day ${outside ? 'outside' : ''} ${k === todayKey ? 'today' : ''} ${past ? 'past' : ''}`}
              onClick={() => !past && newAt(d)}
              title={past ? undefined : 'Agendar neste dia'}
            >
              <div className="cal-num">{d.getDate()}</div>
              {items.map((p) => (
                <button
                  key={p.id}
                  className={`cal-post st-${p.status}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(p);
                  }}
                  title={`${POST_STATUS[p.status].label} · ${p.caption}`}
                >
                  <span className="cal-time">{postDate(p).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="cal-text">
                    {p.media_type === 'REELS' ? '🎬 ' : ''}
                    {postTitle(p)}
                  </span>
                  {p.automation && <span title="Com automação de comentários">💬</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="card-body row wrap small muted" style={{ gap: 14 }}>
        <span><span className="cal-dot st-scheduled" /> Agendada</span>
        <span><span className="cal-dot st-published" /> Publicada</span>
        <span><span className="cal-dot st-failed" /> Com erro</span>
        <span><span className="cal-dot st-cancelled" /> Cancelada</span>
        <span>· Clique num dia para agendar · 💬 = com automação</span>
      </div>
    </div>
  );
}

// ───────────── Formulário ─────────────

/** Converte a imagem para JPG (único formato aceito), corta para a proporção do feed e limita a 1440 px. */
async function prepareImage(file: File): Promise<{ blob: Blob; adjusted: boolean }> {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não consegui abrir essa imagem. Use JPG ou PNG.'));
      i.src = src;
    });
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    let sx = 0;
    let sy = 0;
    const ratio = sw / sh;
    let adjusted = false;
    if (ratio < 0.8) {
      const h = Math.round(sw / 0.8); // muito alta → corta em 4:5
      sy = Math.round((sh - h) / 2);
      sh = h;
      adjusted = true;
    } else if (ratio > 1.91) {
      const w = Math.round(sh * 1.91); // muito larga → corta em 1,91:1
      sx = Math.round((sw - w) / 2);
      sw = w;
      adjusted = true;
    }
    const scale = Math.min(1, 1440 / sw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // PNG com transparência vira fundo branco
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao converter a imagem'))), 'image/jpeg', 0.9),
    );
    return { blob, adjusted };
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function videoDuration(file: File): Promise<number> {
  const src = URL.createObjectURL(file);
  try {
    return await new Promise<number>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve(v.duration);
      v.onerror = () => resolve(NaN);
      v.src = src;
    });
  } finally {
    URL.revokeObjectURL(src);
  }
}

const MAX_VIDEO_MB = 100;

function defaultWhen(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toLocalInput(d);
}
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PostForm({
  post,
  initialWhen,
  accounts,
  flows,
  onClose,
  onSaved,
}: {
  post: Post | null;
  initialWhen?: Date;
  accounts: Account[];
  flows: Flow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const usable = flows.filter((f) => f.status !== 'archived');
  const [accountId, setAccountId] = useState(post?.ig_account_id ?? accounts[0]?.id ?? '');
  const [type, setType] = useState<MediaType>(post?.media_type ?? 'IMAGE');
  const [media, setMedia] = useState<{ url: string; kind: 'image' | 'video' } | null>(post?.media[0] ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [caption, setCaption] = useState(post?.caption ?? '');
  const [mode, setMode] = useState<'now' | 'schedule'>('schedule');
  const [when, setWhen] = useState(() =>
    post && new Date(post.scheduled_at).getTime() > Date.now()
      ? toLocalInput(new Date(post.scheduled_at))
      : initialWhen
        ? toLocalInput(initialWhen)
        : defaultWhen(),
  );
  const [auto, setAuto] = useState(post ? Boolean(post.automation) : true);
  const [flowId, setFlowId] = useState(post?.automation?.flow_id ?? usable.find((f) => f.status === 'published')?.id ?? usable[0]?.id ?? '');
  const [keywords, setKeywords] = useState(post?.automation?.keywords.join(', ') ?? '');
  const [match, setMatch] = useState<Match>(post?.automation?.match ?? 'contains');
  const [replies, setReplies] = useState(post?.automation?.public_replies.join('\n') ?? '');
  const [once, setOnce] = useState(post?.automation?.once_per_contact ?? true);
  const [saving, setSaving] = useState(false);

  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const flow = usable.find((f) => f.id === flowId);

  async function pick(file: File | undefined) {
    if (!file) return;
    setNote(null);
    try {
      let blob: Blob;
      if (type === 'IMAGE') {
        if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem (JPG ou PNG).');
        const r = await prepareImage(file);
        blob = r.blob;
        if (r.adjusted) setNote('A imagem foi cortada para caber no feed (proporção entre 4:5 e 1,91:1).');
      } else {
        if (!['video/mp4', 'video/quicktime'].includes(file.type)) throw new Error('Escolha um vídeo MP4 ou MOV.');
        if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`O vídeo passa de ${MAX_VIDEO_MB} MB. Comprima antes de enviar.`);
        const d = await videoDuration(file);
        if (!Number.isNaN(d) && (d < 3 || d > 15 * 60)) throw new Error('O Reels precisa ter entre 3 segundos e 15 minutos.');
        blob = file;
      }
      setProgress(0);
      const up = await apiUpload(blob, setProgress);
      setMedia({ url: up.url, kind: up.kind });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setProgress(null);
    }
  }

  async function save() {
    if (!media) return toast('Envie a imagem ou o vídeo primeiro.', true);
    if (auto && !flowId) return toast('Escolha o fluxo da automação.', true);
    const scheduled_at = mode === 'now' ? null : new Date(when).toISOString();
    if (scheduled_at && new Date(scheduled_at).getTime() < Date.now()) return toast('Escolha um horário no futuro.', true);
    const body = {
      ig_account_id: accountId,
      media_type: type,
      media: [media],
      caption,
      scheduled_at,
      automation: auto
        ? {
            flow_id: flowId,
            keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
            match,
            public_replies: replies.split('\n').map((r) => r.trim()).filter(Boolean),
            once_per_contact: once,
          }
        : null,
    };
    setSaving(true);
    try {
      if (post) await api(`/app/posts/${post.id}`, { method: 'PUT', body });
      else await api('/app/posts', { body });
      toast(mode === 'now' ? 'Publicando em instantes…' : 'Publicação agendada!');
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
    setSaving(false);
  }

  return (
    <Modal
      title={post ? 'Editar publicação' : 'Agendar publicação'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || progress !== null || !media}>
            {saving ? 'Salvando…' : mode === 'now' ? 'Publicar agora' : 'Agendar'}
          </button>
        </>
      }
    >
      <div className="post-form">
        <div className="stack">
          {accounts.length > 1 && (
            <div className="field">
              <label className="label">Conta</label>
              <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label className="label">Tipo</label>
            <div className="tabs" style={{ marginBottom: 0 }}>
              {(['IMAGE', 'REELS'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={type === t ? 'active' : ''}
                  onClick={() => {
                    if (t === type) return;
                    setType(t);
                    setMedia(null);
                    setNote(null);
                  }}
                >
                  {t === 'IMAGE' ? '🖼 Imagem' : '🎬 Reels'}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">{type === 'IMAGE' ? 'Imagem' : 'Vídeo'}</label>
            <label className="upload-box">
              <input
                type="file"
                accept={type === 'IMAGE' ? 'image/jpeg,image/png,image/webp' : 'video/mp4,video/quicktime'}
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
                disabled={progress !== null}
              />
              {progress !== null ? (
                <div style={{ width: '100%' }}>
                  <div className="small muted">Enviando… {Math.round(progress * 100)}%</div>
                  <div className="progress">
                    <div style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                </div>
              ) : (
                <span className="row">
                  <Icon name="upload" /> {media ? 'Trocar arquivo' : 'Escolher arquivo'}
                </span>
              )}
            </label>
            <span className="hint">
              {type === 'IMAGE'
                ? 'JPG ou PNG. Convertemos para JPG e ajustamos ao formato do feed.'
                : `MP4 ou MOV, de 3 s a 15 min, até ${MAX_VIDEO_MB} MB. Ideal: vertical 9:16.`}
            </span>
            {note && <span className="hint" style={{ color: 'var(--warning)' }}>{note}</span>}
          </div>

          <div className="field">
            <label className="label">Legenda</label>
            <textarea className="input textarea" rows={5} value={caption} maxLength={2200} onChange={(e) => setCaption(e.target.value)} placeholder="Escreva a legenda… Dica: diga qual palavra comentar." />
            <span className="hint" style={hashtags > 30 ? { color: 'var(--danger)' } : undefined}>
              {caption.length}/2200 · {hashtags}/30 hashtags
            </span>
          </div>

          <div className="field">
            <label className="label">Quando</label>
            <div className="row wrap">
              <label className="checkbox">
                <input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} /> Agendar
              </label>
              <label className="checkbox">
                <input type="radio" checked={mode === 'now'} onChange={() => setMode('now')} /> Publicar agora
              </label>
              {mode === 'schedule' && <input className="input" style={{ width: 'auto' }} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
            </div>
            <span className="hint">O robô publica no horário marcado. O computador com o autoflow precisa estar ligado nessa hora.</span>
          </div>
        </div>

        <div className="stack">
          <div className="post-preview">{media ? <Thumb media={media} big /> : <div className="post-thumb big empty-thumb">Prévia</div>}</div>

          <div className="card card-body stack-sm" style={{ background: 'var(--surface-2)' }}>
            <label className="checkbox" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Responder quem comentar
            </label>
            {auto && (
              <>
                {!usable.length ? (
                  <p className="small">
                    Crie um fluxo primeiro em <Link to="/fluxos">Fluxos</Link>.
                  </p>
                ) : (
                  <>
                    <div className="field">
                      <label className="label">Palavra-chave do comentário</label>
                      <div className="row">
                        <select className="select" style={{ width: 'auto' }} value={match} onChange={(e) => setMatch(e.target.value as Match)}>
                          {Object.entries(MATCH).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ex.: QUERO, eu quero" />
                      </div>
                      <span className="hint">Separe por vírgula. Vazio = qualquer comentário neste post.</span>
                    </div>
                    <div className="field">
                      <label className="label">Fluxo enviado no Direct</label>
                      <select className="select" value={flowId} onChange={(e) => setFlowId(e.target.value)}>
                        {usable.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                            {f.status !== 'published' ? ' (rascunho)' : ''}
                          </option>
                        ))}
                      </select>
                      {flow && flow.status !== 'published' && (
                        <span className="hint" style={{ color: 'var(--warning)' }}>
                          Esse fluxo é rascunho: publique antes do horário, senão a automação não responde.
                        </span>
                      )}
                    </div>
                    <div className="field">
                      <label className="label">Resposta pública no comentário (opcional)</label>
                      <textarea className="input textarea" rows={2} value={replies} onChange={(e) => setReplies(e.target.value)} placeholder={'Te chamei no Direct! 📩\nAcabei de te mandar no Direct 😉'} />
                      <span className="hint">Uma por linha — o robô sorteia uma.</span>
                    </div>
                    <label className="checkbox small">
                      <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> Só uma vez por pessoa
                    </label>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
