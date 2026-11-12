/**
 * Funil da publicação: do comentário ao pedido. Cada etapa é um pedaço da anterior, contada em pessoas.
 */
import { api } from '../lib/api';
import { postTitle, type Post } from '../lib/posts';
import { ErrorBox, Loading, Modal, useLoad } from './ui';

interface Funnel {
  has_automation: boolean;
  published: boolean;
  comments: number;
  commenters: number;
  served: number;
  tapped: number;
  not_following: number;
  gained: number;
  clicked: number;
  emails: number;
  orders: number;
  paid_cents: number;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function PostFunnel({ post, onClose }: { post: Post; onClose: () => void }) {
  const f = useLoad(() => api<Funnel>(`/app/posts/${post.id}/funnel`), [post.id]);
  const d = f.data;

  return (
    <Modal wide={720} title={`📊 Resultado: ${postTitle(post)}`} onClose={onClose}>
      <ErrorBox error={f.error} />
      {!d ? (
        <Loading />
      ) : !d.published ? (
        <p className="muted">Os números aparecem depois que a publicação sair no Instagram.</p>
      ) : (
        <div className="stack">
          <div className="funnel-tiles">
            <Tile n={d.gained} label="seguidores ganhos" hint={`de ${d.not_following} que ainda não seguiam`} accent />
            <Tile n={d.clicked} label="clicaram no link" hint={`${pct(d.clicked, d.served)}% de quem foi atendido`} />
            <Tile n={d.emails} label="e-mails captados" hint={d.orders ? `${d.orders} pedido(s) · ${brl(d.paid_cents)} pagos` : 'leads deste post'} />
          </div>

          <div className="funnel">
            <Step label="Pessoas que comentaram" n={d.commenters} of={d.commenters} note={`${d.comments} comentário(s) no total`} />
            <Step label="Atendidas pela automação" n={d.served} of={d.commenters} />
            <Step label="Tocaram no botão do Direct" n={d.tapped} of={d.served} />
            {d.not_following > 0 && <Step label="Não seguiam e passaram a seguir" n={d.gained} of={d.not_following} prev="de quem não seguia" />}
            <Step label="Clicaram no link" n={d.clicked} of={d.served} prev="das atendidas" />
            {d.emails > 0 && <Step label="Deixaram o e-mail" n={d.emails} of={d.served} prev="das atendidas" />}
            {d.orders > 0 && <Step label="Fizeram pedido" n={d.orders} of={d.served} prev="das atendidas" />}
          </div>

          <p className="hint">
            Conta pessoas, não comentários: quem comentou duas vezes aparece uma vez. "Seguidores ganhos" são os que não seguiam quando falaram com
            a automação e passaram a seguir depois. Os números de seguidores começam a ser contados a partir desta atualização.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Tile({ n, label, hint, accent }: { n: number; label: string; hint: string; accent?: boolean }) {
  return (
    <div className={`funnel-tile ${accent ? 'accent' : ''}`}>
      <div className="funnel-n">{n.toLocaleString('pt-BR')}</div>
      <div className="funnel-label">{label}</div>
      <div className="muted small">{hint}</div>
    </div>
  );
}

function Step({ label, n, of, note, prev = 'da etapa anterior' }: { label: string; n: number; of: number; note?: string; prev?: string }) {
  const w = of > 0 ? Math.max(2, Math.round((n / of) * 100)) : 0;
  return (
    <div className="funnel-step">
      <div className="row-between small">
        <span>{label}</span>
        <span>
          <b>{n.toLocaleString('pt-BR')}</b>
          {of > 0 && n !== of && <span className="muted"> · {pct(n, of)}% {prev}</span>}
        </span>
      </div>
      <div className="funnel-bar">
        <span style={{ width: `${w}%` }} />
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}
