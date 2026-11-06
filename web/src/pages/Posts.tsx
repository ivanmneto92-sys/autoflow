import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, Icon, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api, apiUpload, formatDateTime } from '../lib/api';
import { isEditable, MATCH_LABEL, POST_STATUS, postDate, postTitle, TYPE_LABEL, type Match, type MediaType, type Post } from '../lib/posts';
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
            {TYPE_LABEL[p.media_type]}
            {p.media_type === 'CAROUSEL' ? ` (${p.media.length})` : ''} · @{p.username} ·{' '}
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
                    {p.media_type === 'REELS' ? '🎬 ' : p.media_type === 'CAROUSEL' ? '🗂 ' : ''}
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
/**
 * Converte para JPG e ajusta a proporção. `ratio` força uma proporção exata (carrossel: todos iguais ao 1º item,
 * senão o Instagram corta os outros sozinho).
 */
export async function prepareImage(file: File, ratio?: number): Promise<{ blob: Blob; adjusted: boolean; ratio: number }> {
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
    const own = sw / sh;
    const target = ratio ?? Math.min(1.91, Math.max(0.8, own)); // feed: entre 4:5 e 1,91:1
    let adjusted = false;
    if (Math.abs(own - target) > 0.01) {
      adjusted = true;
      if (own < target) {
        const h = Math.round(sw / target); // mais alta que o alvo → corta em cima e embaixo
        sy = Math.round((sh - h) / 2);
        sh = h;
      } else {
        const w = Math.round(sh * target); // mais larga → corta nas laterais
        sx = Math.round((sw - w) / 2);
        sw = w;
      }
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
    return { blob, adjusted, ratio: target };
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
const CAROUSEL_MAX = 10;

/** Proporção (largura/altura) de uma imagem já enviada. */
function imageRatio(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i.naturalWidth / i.naturalHeight);
    i.onerror = () => resolve(undefined);
    i.src = url;
  });
}
type MediaItem = { url: string; kind: 'image' | 'video' };

function defaultWhen(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toLocalInput(d);
}
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PostForm({
  post,
  initialWhen,
  accounts,
  flows,
  onClose,
  onSaved,
  initialFlowId,
}: {
  post: Post | null;
  initialWhen?: Date;
  accounts: Account[];
  flows: Flow[];
  onClose: () => void;
  onSaved: () => void;
  initialFlowId?: string;
}) {
  const toast = useToast();
  const [extra, setExtra] = useState<Flow[]>([]); // fluxos criados aqui mesmo (fluxo rápido)
  const usable = [...flows, ...extra].filter((f) => f.status !== 'archived');
  const [quick, setQuick] = useState(false);
  const [accountId, setAccountId] = useState(post?.ig_account_id ?? accounts[0]?.id ?? '');
  const [type, setType] = useState<MediaType>(post?.media_type ?? 'IMAGE');
  const [items, setItems] = useState<MediaItem[]>(post?.media ?? []);
  const [sel, setSel] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [upLabel, setUpLabel] = useState('');
  const media = items[Math.min(sel, items.length - 1)] ?? null;
  const isCarousel = type === 'CAROUSEL';
  const ratioOf = useRef<number | undefined>(undefined); // proporção da 1ª foto do carrossel
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
  // Padrão: só agenda o post; o fluxo escolhe a publicação depois (⚡ Quando… → Comentário em post)
  const [auto, setAuto] = useState(post ? Boolean(post.automation) : Boolean(initialFlowId));
  const [flowId, setFlowId] = useState(post?.automation?.flow_id ?? initialFlowId ?? usable.find((f) => f.status === 'published')?.id ?? usable[0]?.id ?? '');
  const [keywords, setKeywords] = useState(post?.automation?.keywords.join(', ') ?? '');
  const [match, setMatch] = useState<Match>(post?.automation?.match ?? 'contains');
  const [replies, setReplies] = useState(post?.automation?.public_replies.join('\n') ?? '');
  const [once, setOnce] = useState(post?.automation?.once_per_contact ?? true);
  const [saving, setSaving] = useState(false);

  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  const flow = usable.find((f) => f.id === flowId);

  /** Prepara um arquivo conforme o tipo e envia. `ratio`: proporção forçada (itens do carrossel depois do 1º). */
  async function prepare(file: File, ratio?: number): Promise<{ blob: Blob; adjusted: boolean; ratio?: number }> {
    if (file.type.startsWith('image/') && type !== 'REELS') return prepareImage(file, ratio);
    if (type === 'IMAGE') throw new Error('Escolha um arquivo de imagem (JPG ou PNG).');
    if (!['video/mp4', 'video/quicktime'].includes(file.type)) throw new Error(type === 'REELS' ? 'Escolha um vídeo MP4 ou MOV.' : `${file.name}: use JPG, PNG, MP4 ou MOV.`);
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`O vídeo passa de ${MAX_VIDEO_MB} MB. Comprima antes de enviar.`);
    const d = await videoDuration(file);
    if (type === 'REELS' && !Number.isNaN(d) && (d < 3 || d > 15 * 60)) throw new Error('O Reels precisa ter entre 3 segundos e 15 minutos.');
    if (type === 'CAROUSEL' && !Number.isNaN(d) && (d < 3 || d > 60)) throw new Error(`${file.name}: vídeo de carrossel precisa ter entre 3 e 60 segundos.`);
    return { blob: file, adjusted: false };
  }

  async function pick(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setNote(null);
    if (!isCarousel) {
      try {
        const r = await prepare(files[0]!);
        if (r.adjusted) setNote('A imagem foi cortada para caber no feed (proporção entre 4:5 e 1,91:1).');
        setProgress(0);
        setUpLabel('');
        const up = await apiUpload(r.blob, setProgress);
        setItems([{ url: up.url, kind: up.kind }]);
        setSel(0);
      } catch (e) {
        toast((e as Error).message, true);
      } finally {
        setProgress(null);
      }
      return;
    }
    // Carrossel: vários de uma vez, na ordem escolhida, até 10 no total
    const room = CAROUSEL_MAX - items.length;
    if (files.length > room) toast(`O carrossel aceita até ${CAROUSEL_MAX} itens — enviando só os ${room} primeiros.`, true);
    const ordered = files.slice(0, Math.max(0, room)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    if (items.length && ratioOf.current === undefined && items[0]!.kind === 'image') ratioOf.current = await imageRatio(items[0]!.url);
    let ratio = items.length ? ratioOf.current : undefined;
    let cropped = 0;
    const added: MediaItem[] = [];
    try {
      for (const [i, file] of ordered.entries()) {
        setUpLabel(`${i + 1}/${ordered.length}`);
        const r = await prepare(file, ratio);
        if (r.ratio && ratio === undefined) ratio = ratioOf.current = r.ratio;
        if (r.adjusted) cropped++;
        setProgress(0);
        const up = await apiUpload(r.blob, setProgress);
        added.push({ url: up.url, kind: up.kind });
        setItems((cur) => [...cur, { url: up.url, kind: up.kind }]);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setProgress(null);
      setUpLabel('');
    }
    if (added.length && !items.length) setSel(0);
    if (cropped) setNote(`${cropped} ${cropped === 1 ? 'imagem foi cortada' : 'imagens foram cortadas'} para ficar no mesmo formato da primeira (o Instagram exige).`);
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    setItems((cur) => {
      const n = [...cur];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
    setSel(j);
  }

  function remove(i: number) {
    setItems((cur) => cur.filter((_, k) => k !== i));
    setSel((s) => Math.max(0, Math.min(s, items.length - 2)));
  }

  async function save() {
    if (!items.length) return toast('Envie a imagem ou o vídeo primeiro.', true);
    if (isCarousel && items.length < 2) return toast('O carrossel precisa de pelo menos 2 fotos ou vídeos.', true);
    if (auto && !flowId) return toast('Escolha o fluxo da automação (ou crie um rápido aqui mesmo).', true);
    const scheduled_at = mode === 'now' ? null : new Date(when).toISOString();
    if (scheduled_at && new Date(scheduled_at).getTime() < Date.now()) return toast('Escolha um horário no futuro.', true);
    const body = {
      ig_account_id: accountId,
      media_type: type,
      media: items,
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
          <button className="btn btn-primary" onClick={save} disabled={saving || progress !== null || !items.length || (isCarousel && items.length < 2)}>
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
              {(['IMAGE', 'CAROUSEL', 'REELS'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={type === t ? 'active' : ''}
                  onClick={() => {
                    if (t === type) return;
                    // Imagem ↔ carrossel aproveita as fotos já enviadas
                    const keep = t !== 'REELS' && type !== 'REELS' ? items.filter((m) => m.kind === 'image') : [];
                    setType(t);
                    setItems(t === 'IMAGE' ? keep.slice(0, 1) : keep);
                    setSel(0);
                    setNote(null);
                  }}
                >
                  {t === 'IMAGE' ? '🖼 Imagem' : t === 'CAROUSEL' ? '🗂 Carrossel' : '🎬 Reels'}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">
              {type === 'IMAGE' ? 'Imagem' : type === 'CAROUSEL' ? `Fotos e vídeos (${items.length}/${CAROUSEL_MAX})` : 'Vídeo'}
            </label>
            {isCarousel && items.length > 0 && (
              <div className="carousel-strip">
                {items.map((m, i) => (
                  <div key={m.url} className={`carousel-item ${i === sel ? 'sel' : ''}`} onClick={() => setSel(i)}>
                    {m.kind === 'video' ? <video src={`${m.url}#t=0.5`} muted playsInline preload="metadata" /> : <img src={m.url} alt="" />}
                    <span className="carousel-n">{i + 1}</span>
                    <div className="carousel-tools" onClick={(e) => e.stopPropagation()}>
                      <button type="button" title="Mover para a esquerda" disabled={i === 0} onClick={() => move(i, -1)}>
                        ‹
                      </button>
                      <button type="button" title="Remover" onClick={() => remove(i)}>
                        ×
                      </button>
                      <button type="button" title="Mover para a direita" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                        ›
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <label className="upload-box" style={isCarousel && items.length >= CAROUSEL_MAX ? { display: 'none' } : undefined}>
              <input
                type="file"
                multiple={isCarousel}
                accept={type === 'IMAGE' ? 'image/jpeg,image/png,image/webp' : type === 'CAROUSEL' ? 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime' : 'video/mp4,video/quicktime'}
                onChange={(e) => {
                  pick(e.target.files);
                  e.target.value = '';
                }}
                disabled={progress !== null}
              />
              {progress !== null ? (
                <div style={{ width: '100%' }}>
                  <div className="small muted">
                    Enviando{upLabel ? ` ${upLabel}` : ''}… {Math.round(progress * 100)}%
                  </div>
                  <div className="progress">
                    <div style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                </div>
              ) : (
                <span className="row">
                  <Icon name="upload" />{' '}
                  {isCarousel ? (items.length ? 'Adicionar mais' : 'Escolher fotos (pode selecionar várias)') : media ? 'Trocar arquivo' : 'Escolher arquivo'}
                </span>
              )}
            </label>
            <span className="hint">
              {type === 'IMAGE'
                ? 'JPG ou PNG. Convertemos para JPG e ajustamos ao formato do feed.'
                : type === 'CAROUSEL'
                  ? 'De 2 a 10 fotos (JPG/PNG) ou vídeos de até 60 s. Todas ficam no formato da primeira. Use ‹ › para mudar a ordem.'
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
          <div className="post-preview">
            {media ? <Thumb media={media} big /> : <div className="post-thumb big empty-thumb">Prévia</div>}
            {isCarousel && items.length > 1 && (
              <div className="carousel-nav">
                <button type="button" onClick={() => setSel((s) => Math.max(0, s - 1))} disabled={sel === 0}>
                  ‹
                </button>
                <span>
                  {Math.min(sel, items.length - 1) + 1}/{items.length}
                </span>
                <button type="button" onClick={() => setSel((s) => Math.min(items.length - 1, s + 1))} disabled={sel >= items.length - 1}>
                  ›
                </button>
              </div>
            )}
          </div>

          <div className="card card-body stack-sm" style={{ background: 'var(--surface-2)' }}>
            <label className="checkbox" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Responder quem comentar
            </label>
            {!auto && (
              <p className="small muted" style={{ margin: 0 }}>
                Pode agendar só a publicação. Depois, no fluxo, clique em <b>⚡ Quando… → + Novo gatilho → Comentário em post</b> e escolha esta
                publicação.
              </p>
            )}
            {auto && (
              <>
                {!usable.length && !quick ? (
                  <div className="stack-sm">
                    <p className="small" style={{ margin: 0 }}>
                      Você ainda não tem fluxos. O caminho mais simples: agende sem marcar esta opção e, no fluxo, escolha esta publicação em{' '}
                      <b>⚡ Quando… → Comentário em post</b>.
                    </p>
                    <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setQuick(true)}>
                      Ou criar um fluxo rápido aqui
                    </button>
                  </div>
                ) : quick ? (
                  <QuickFlow
                    suggestedName={postTitle({ caption, media_type: type } as Post)}
                    canCancel
                    onCancel={() => setQuick(false)}
                    onCreated={(f) => {
                      setExtra((x) => [...x, f]);
                      setFlowId(f.id);
                      setQuick(false);
                    }}
                  />
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
                      <select
                        className="select"
                        value={flowId}
                        onChange={(e) => (e.target.value === '__new' ? setQuick(true) : setFlowId(e.target.value))}
                      >
                        {usable.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                            {f.status !== 'published' ? ' (rascunho)' : ''}
                          </option>
                        ))}
                        <option value="__new">＋ Criar um fluxo rápido aqui</option>
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

/**
 * Fluxo rápido criado de dentro do agendador: uma mensagem no Direct (com link opcional), já publicado.
 * Quebra o "ovo e galinha" (post pede fluxo, fluxo pede post). Dá para incrementar depois no editor.
 */
function QuickFlow({
  suggestedName,
  canCancel,
  onCancel,
  onCreated,
}: {
  suggestedName: string;
  canCancel: boolean;
  onCancel: () => void;
  onCreated: (f: Flow) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('Oi, {{first_name|tudo bem}}! 👋 Aqui está o que você pediu:');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('Acessar');
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!text.trim()) return toast('Escreva a mensagem que vai no Direct.', true);
    let link = url.trim();
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    setBusy(true);
    try {
      const name = `Post: ${suggestedName}`.slice(0, 100);
      const f = await api<{ id: string; name: string }>('/app/flows', { body: { name } });
      const graph = {
        start: 'msg',
        nodes: {
          msg: {
            type: 'message',
            data: { text: text.trim(), ...(link ? { buttons: [{ label: (label.trim() || 'Acessar').slice(0, 20), url: link }] } : {}) },
            next: null,
          },
        },
      };
      const saved = await api<{ issues: { level: string; message: string }[] }>(`/app/flows/${f.id}`, { method: 'PUT', body: { graph } });
      const err = saved.issues.find((i) => i.level === 'error');
      if (err) throw new Error(err.message);
      await api(`/app/flows/${f.id}/publish`, { body: {} });
      toast('Fluxo criado e publicado ✓');
      onCreated({ id: f.id, name, status: 'published' });
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  return (
    <div className="stack-sm">
      <div className="small">
        <b>Fluxo rápido:</b> o que quem comentar recebe no Direct. Depois dá para melhorar em <b>Fluxos</b>.
      </div>
      <textarea className="input textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link (opcional): seusite.com.br" />
        <input className="input" style={{ maxWidth: 120 }} value={label} maxLength={20} onChange={(e) => setLabel(e.target.value)} placeholder="Texto do botão" />
      </div>
      <div className="row wrap">
        <button type="button" className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
          {busy ? 'Criando…' : 'Criar e publicar fluxo'}
        </button>
        {canCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Voltar
          </button>
        )}
        <a className="small" href="/modelos" target="_blank" rel="noreferrer">
          ou use um modelo pronto ↗
        </a>
      </div>
    </div>
  );
}
