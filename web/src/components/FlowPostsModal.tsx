import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDateTime } from '../lib/api';
import { describeAutomation, isEditable, MATCH_LABEL, POST_STATUS, postDate, postTitle, TYPE_LABEL, type Match, type Post } from '../lib/posts';
import { PostForm } from '../pages/Posts';
import { ReplyVariants } from './ReplyVariants';
import { ErrorBox, Icon, Loading, Modal, useLoad, useToast } from './ui';

/** No editor de fluxo: mostra em quais publicações o fluxo é usado e liga ele a uma publicação agendada. */
export function FlowPostsModal({ flowId, flowPublished, onClose }: { flowId: string; flowPublished: boolean; onClose: () => void }) {
  const toast = useToast();
  const posts = useLoad(() => api<Post[]>('/app/posts'), []);
  const list = posts.data ?? [];
  const linked = list.filter((p) => p.automation?.flow_id === flowId).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
  const candidates = list.filter((p) => isEditable(p) && p.automation?.flow_id !== flowId).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());

  const [postId, setPostId] = useState('');
  const [keywords, setKeywords] = useState('');
  const [match, setMatch] = useState<Match>('contains');
  const [replies, setReplies] = useState<string[]>(['Te mandei no Direct! 📩']);
  const [once, setOnce] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const accounts = useLoad(() => (scheduling ? api<{ id: string; username: string; status: string }[]>('/app/accounts') : Promise.resolve(null)), [scheduling]);
  const flows = useLoad(() => (scheduling ? api<{ id: string; name: string; status: string }[]>('/app/flows') : Promise.resolve(null)), [scheduling]);

  const chosen = candidates.find((p) => p.id === (postId || candidates[0]?.id));

  async function link() {
    if (!chosen) return;
    setBusy(true);
    try {
      await api(`/app/posts/${chosen.id}/automation`, {
        method: 'PUT',
        body: {
          automation: {
            flow_id: flowId,
            keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
            match,
            public_replies: replies.map((r) => r.trim()).filter(Boolean),
            once_per_contact: once,
          },
        },
      });
      toast('Fluxo vinculado à publicação');
      setPostId('');
      setKeywords('');
      setReplies(['Te mandei no Direct! 📩']);
      posts.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  async function unlink(p: Post) {
    if (!confirm('Tirar a automação desta publicação? O post continua agendado.')) return;
    try {
      await api(`/app/posts/${p.id}/automation`, { method: 'PUT', body: { automation: null } });
      toast('Automação removida');
      posts.reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  if (scheduling) {
    const active = (accounts.data ?? []).filter((a) => a.status === 'active');
    if (!accounts.data || !flows.data)
      return (
        <Modal title="Agendar publicação" onClose={() => setScheduling(false)}>
          <ErrorBox error={accounts.error ?? flows.error} />
          <Loading />
        </Modal>
      );
    if (!active.length)
      return (
        <Modal title="Agendar publicação" onClose={() => setScheduling(false)}>
          <p>
            Conecte uma conta do Instagram primeiro em <Link to="/instagram">Instagram</Link>.
          </p>
        </Modal>
      );
    return (
      <PostForm
        post={null}
        accounts={active}
        flows={flows.data}
        initialFlowId={flowId}
        onClose={() => setScheduling(false)}
        onSaved={() => {
          setScheduling(false);
          posts.reload();
        }}
      />
    );
  }

  return (
    <Modal title="Usar este fluxo numa publicação" onClose={onClose} wide>
      {posts.loading && !posts.data ? (
        <Loading />
      ) : (
        <div className="stack">
          <ErrorBox error={posts.error} />
          {!flowPublished && (
            <div className="alert alert-warning small">
              Este fluxo ainda não está publicado. Clique em <b>Publicar</b> antes do horário do post, senão quem comentar não recebe nada.
            </div>
          )}

          <div>
            <div className="label">Publicações que usam este fluxo</div>
            {!linked.length ? (
              <p className="muted small">Nenhuma ainda.</p>
            ) : (
              <div className="stack-sm">
                {linked.map((p) => (
                  <div key={p.id} className="row" style={{ gap: 10 }}>
                    <MiniThumb p={p} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <span className={`badge ${POST_STATUS[p.status].cls}`}>{POST_STATUS[p.status].label}</span>
                        <span className="small muted">{formatDateTime(postDate(p).toISOString())}</span>
                      </div>
                      <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {postTitle(p)} · {describeAutomation(p.automation!)}
                      </div>
                    </div>
                    {isEditable(p) ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => unlink(p)}>
                        Remover
                      </button>
                    ) : p.status === 'published' ? (
                      <Link className="btn btn-sm" to="/gatilhos">
                        Ver gatilho
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setScheduling(true)}>
            <Icon name="calendar" /> Agendar nova publicação com este fluxo
          </button>

          <div className="card card-body stack-sm" style={{ background: 'var(--surface-2)' }}>
            <div className="label" style={{ marginBottom: 0 }}>
              Ou vincular a uma publicação já agendada
            </div>
            {!candidates.length ? (
              <p className="small muted">Nenhuma publicação agendada ainda. Use o botão acima para agendar uma já com este fluxo.</p>
            ) : (
              <>
                <select className="select" value={chosen?.id ?? ''} onChange={(e) => setPostId(e.target.value)}>
                  {candidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {formatDateTime(postDate(p).toISOString())} · {TYPE_LABEL[p.media_type]} · {postTitle(p)}
                      {p.status !== 'scheduled' ? ` (${POST_STATUS[p.status].label.toLowerCase()})` : ''}
                    </option>
                  ))}
                </select>
                {chosen?.automation && (
                  <span className="hint" style={{ color: 'var(--warning)' }}>
                    Esse post já tem automação com o fluxo "{chosen.flow_name}". Vincular aqui substitui.
                  </span>
                )}
                <div className="row">
                  <select className="select" style={{ width: 'auto' }} value={match} onChange={(e) => setMatch(e.target.value as Match)}>
                    {Object.entries(MATCH_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="Palavra do comentário (ex.: QUERO)" />
                </div>
                <span className="hint">Separe por vírgula. Vazio = qualquer comentário no post.</span>
                <label className="label" style={{ marginBottom: 0 }}>
                  Resposta pública no comentário (opcional)
                </label>
                <ReplyVariants value={replies} onChange={setReplies} />
                <div className="row-between">
                  <label className="checkbox small">
                    <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> Só uma vez por pessoa
                  </label>
                  <button className="btn btn-primary" onClick={link} disabled={busy || !chosen}>
                    {busy ? 'Vinculando…' : 'Vincular'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function MiniThumb({ p }: { p: Post }) {
  const m = p.media[0];
  const style = { width: 40, height: 50, borderRadius: 6, objectFit: 'cover' as const, background: 'var(--surface-2)', flex: 'none' as const };
  if (!m) return <div style={style} />;
  return m.kind === 'video' ? <video src={`${m.url}#t=0.5`} muted preload="metadata" style={style} /> : <img src={m.url} alt="" style={style} />;
}
