/**
 * Automação rápida "Comentário → Direct": uma tela, sem montar fluxo. Gera um fluxo normal (publicado) que dá
 * para abrir no editor depois. Modo "flow-only" é usado pelo agendador (lá o post e as palavras já são escolhidos).
 */
import { useState, type ReactNode } from 'react';
import { ImagePicker } from '../editor/Inspector';
import { api, formatDateTime } from '../lib/api';
import { postTitle, TYPE_LABEL, type Post } from '../lib/posts';
import { MediaPicker, ScheduledPicker } from '../pages/Triggers';
import { LOCK_DEFAULTS } from '../shared/schema';
import { Icon, Modal, useToast } from './ui';

type Target = { kind: 'any' } | { kind: 'media'; media_id: string } | { kind: 'scheduled'; post: Post };

const FOLLOW_UP_OPTIONS: [number, string][] = [
  [30, '30 minutos'],
  [60, '1 hora'],
  [180, '3 horas'],
  [720, '12 horas'],
  [1380, '23 horas'],
];

export function QuickAutomation({
  mode = 'full',
  initialPost,
  onClose,
  onCreated,
}: {
  mode?: 'full' | 'flow-only';
  initialPost?: Post;
  onClose: () => void;
  onCreated: (flow: { id: string; name: string }) => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState<Target>(initialPost ? { kind: 'scheduled', post: initialPost } : { kind: 'any' });
  const [picker, setPicker] = useState<'media' | 'scheduled' | null>(null);
  const [keywords, setKeywords] = useState('');
  const [replies, setReplies] = useState<string[]>(['Te mandei no Direct! 📩', 'Corre no Direct 😉', 'Acabei de te chamar no Direct 💌']);
  const [once, setOnce] = useState(true);
  const [opening, setOpening] = useState(true);
  const [openingText, setOpeningText] = useState('Oi, {{first_name|tudo bem}}! 👋 Que bom que você comentou. Toque no botão abaixo que eu te mando agora 👇');
  const [openingButton, setOpeningButton] = useState('Quero receber');
  const [lock, setLock] = useState(false);
  const [lockedText, setLockedText] = useState(LOCK_DEFAULTS.locked_text);
  const [retryLabel, setRetryLabel] = useState(LOCK_DEFAULTS.retry);
  const [profileLabel, setProfileLabel] = useState(LOCK_DEFAULTS.profile);
  const [email, setEmail] = useState(false);
  const [emailText, setEmailText] = useState('Antes, me passa seu melhor e-mail? Assim te aviso das novidades 💌');
  const [msgText, setMsgText] = useState('Aqui está o que você pediu 🎉');
  const [image, setImage] = useState('');
  const [links, setLinks] = useState<{ label: string; url: string }[]>([{ label: 'Acessar', url: '' }]);
  const [followUp, setFollowUp] = useState(false);
  const [followMinutes, setFollowMinutes] = useState(60);
  const [followText, setFollowText] = useState('Conseguiu ver? 👀 Deixo o link aqui de novo pra você:');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Depois de um comentário, só a abertura libera as mensagens seguintes
  const needsOpening = lock || email || followUp;
  const openingOn = opening || needsOpening;
  const validLinks = links.filter((l) => l.label.trim() && l.url.trim());

  async function save() {
    if (!msgText.trim()) return toast('Escreva a mensagem com o conteúdo.', true);
    if (links.some((l) => l.url.trim() && !l.label.trim())) return toast('Dê um nome para cada botão de link.', true);
    if (target.kind === 'media' && !target.media_id) return toast('Escolha o post.', true);
    setBusy(true);
    try {
      const r = await api<{ flow_id: string; notes: string[] }>('/app/automations/comment-dm', {
        body: {
          name: name.trim() || undefined,
          target: mode === 'flow-only' ? { kind: 'none' } : target.kind === 'scheduled' ? { kind: 'scheduled', post_id: target.post.id } : target,
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          public_replies: replies.map((r) => r.trim()).filter(Boolean),
          once_per_contact: once,
          opening: { enabled: openingOn, text: openingText, button: openingButton },
          followers_only: lock,
          locked_text: lock ? lockedText : undefined,
          retry_label: lock && retryLabel.trim() ? retryLabel.trim() : undefined,
          profile_label: lock && profileLabel.trim() ? profileLabel.trim() : undefined,
          ask_email: { enabled: email, text: emailText },
          message: { text: msgText, image_url: image || undefined, links: validLinks },
          follow_up: { enabled: followUp && validLinks.length > 0, minutes: followMinutes, text: followText },
        },
      });
      for (const n of r.notes) toast(n);
      const flowName = name.trim() || `Comentário → Direct${keywords.trim() ? ` (${keywords.split(',')[0]!.trim()})` : ''}`;
      toast(mode === 'flow-only' ? 'Fluxo criado e publicado ✓' : 'Automação ativa! ✓ Quem comentar já recebe no Direct.');
      onCreated({ id: r.flow_id, name: flowName });
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide={1040}
      title="⚡ Automação rápida: Comentário → Direct"
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            Cria um fluxo pronto — dá para ajustar tudo depois no editor.
          </span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Ativando…' : mode === 'flow-only' ? 'Criar fluxo' : 'Ativar automação'}
          </button>
        </>
      }
    >
      <div className="qa">
        <div className="qa-form">
          {mode === 'full' && (
            <>
              <Section n={1} title="Em qual post?">
                <div className="qa-choices">
                  <label className="checkbox">
                    <input type="radio" checked={target.kind === 'any'} onChange={() => setTarget({ kind: 'any' })} /> Qualquer post ou Reels
                  </label>
                  <label className="checkbox">
                    <input type="radio" checked={target.kind === 'media'} onChange={() => setPicker('media')} /> Um post já publicado
                    {target.kind === 'media' && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicker('media')}>
                        trocar
                      </button>
                    )}
                  </label>
                  <label className="checkbox">
                    <input type="radio" checked={target.kind === 'scheduled'} onChange={() => setPicker('scheduled')} /> Um post agendado aqui no autoflow
                  </label>
                  {target.kind === 'scheduled' && (
                    <div className="qa-picked">
                      {target.post.media[0] && <img src={target.post.media[0].url} alt="" />}
                      <div className="small">
                        <b>{postTitle(target.post)}</b>
                        <div className="muted">
                          {TYPE_LABEL[target.post.media_type]} · {formatDateTime(target.post.scheduled_at)}
                        </div>
                      </div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicker('scheduled')}>
                        trocar
                      </button>
                    </div>
                  )}
                </div>
              </Section>

              <Section n={2} title="Quando comentarem">
                <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="Palavra (ex.: CANVA). Vazio = qualquer comentário" />
                <span className="hint">Separe por vírgula. Maiúsculas e acentos não importam.</span>
                <label className="label" style={{ marginTop: 8 }}>
                  Resposta pública no comentário
                </label>
                {replies.map((r, i) => (
                  <div className="row" key={i}>
                    <textarea
                      className="textarea"
                      rows={r.includes('\n') ? 3 : 1}
                      style={{ minHeight: r.includes('\n') ? 76 : 42, resize: 'vertical' }}
                      value={r}
                      placeholder="Ex.: Te mandei no Direct! 📩"
                      onChange={(e) => setReplies(replies.map((x, k) => (k === i ? e.target.value : x)))}
                    />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplies(replies.filter((_, k) => k !== i))} title="Remover">
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
                {replies.length < 10 && (
                  <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setReplies([...replies, ''])}>
                    <Icon name="plus" /> Outra versão
                  </button>
                )}
                <span className="hint">Cada caixa é uma resposta completa (pode ter várias linhas). Com mais de uma, o robô sorteia — fica mais natural.</span>
                <label className="checkbox small">
                  <input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> Responder só 1 vez por pessoa
                </label>
              </Section>
            </>
          )}

          <Section n={mode === 'full' ? 3 : 1} title="Mensagem de abertura" toggle={needsOpening ? undefined : { on: opening, set: setOpening }}>
            {openingOn ? (
              <>
                <textarea className="textarea" rows={3} value={openingText} onChange={(e) => setOpeningText(e.target.value)} />
                <input className="input" maxLength={20} value={openingButton} onChange={(e) => setOpeningButton(e.target.value)} placeholder="Texto do botão" />
                <span className="hint">
                  Depois de um comentário, a Meta só deixa mandar <b>1 mensagem</b>. O toque nesse botão libera o resto
                  {needsOpening ? ' — por isso ela fica ligada com 🔒, e-mail ou lembrete.' : '.'}
                </span>
              </>
            ) : (
              <span className="hint">Desligada: o conteúdo vai direto como a 1ª mensagem.</span>
            )}
          </Section>

          <Section n={mode === 'full' ? 4 : 2} title="🔒 Só para seguidores" toggle={{ on: lock, set: setLock }}>
            {lock && (
              <>
                <span className="hint">Ao tocar no botão da abertura, o robô confere se a pessoa segue. Quem segue recebe o conteúdo; quem não segue recebe:</span>
                <textarea className="textarea" rows={3} value={lockedText} onChange={(e) => setLockedText(e.target.value)} />
                <div className="row">
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label">Botão para tentar de novo</label>
                    <input className="input" maxLength={20} value={retryLabel} onChange={(e) => setRetryLabel(e.target.value)} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label">Botão do perfil</label>
                    <input className="input" maxLength={20} value={profileLabel} onChange={(e) => setProfileLabel(e.target.value)} />
                  </div>
                </div>
              </>
            )}
          </Section>

          <Section n={mode === 'full' ? 5 : 3} title="Pedir e-mail" toggle={{ on: email, set: setEmail }}>
            {email && (
              <>
                <textarea className="textarea" rows={2} value={emailText} onChange={(e) => setEmailText(e.target.value)} />
                <span className="hint">Vai com o botão “Agora não”. Quem pular ou não responder em 30 min recebe o conteúdo do mesmo jeito.</span>
              </>
            )}
          </Section>

          <Section n={mode === 'full' ? 6 : 4} title="Mensagem com o conteúdo">
            <textarea className="textarea" rows={3} value={msgText} onChange={(e) => setMsgText(e.target.value)} />
            <label className="label">Foto (opcional)</label>
            <ImagePicker optional value={image} onChange={setImage} />
            <label className="label" style={{ marginTop: 6 }}>
              Botões de link (até 3)
            </label>
            {links.map((l, i) => (
              <div className="row" key={i}>
                <input
                  className="input"
                  style={{ maxWidth: 150 }}
                  maxLength={20}
                  value={l.label}
                  placeholder="Texto do botão"
                  onChange={(e) => setLinks(links.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
                />
                <input className="input" value={l.url} placeholder="seusite.com.br/material" onChange={(e) => setLinks(links.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)))} />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLinks(links.filter((_, k) => k !== i))} title="Remover">
                  <Icon name="x" />
                </button>
              </div>
            ))}
            {links.length < 3 && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLinks([...links, { label: '', url: '' }])}>
                <Icon name="plus" /> Link
              </button>
            )}
            <span className="hint">Os cliques são contados: você vê em Publicações quantos abriram o link.</span>
          </Section>

          <Section n={mode === 'full' ? 7 : 5} title="Lembrete para quem não clicar" toggle={{ on: followUp, set: setFollowUp }}>
            {followUp &&
              (validLinks.length ? (
                <>
                  <div className="row">
                    <span className="small">Esperar</span>
                    <select className="select" style={{ width: 'auto' }} value={followMinutes} onChange={(e) => setFollowMinutes(Number(e.target.value))}>
                      {FOLLOW_UP_OPTIONS.map(([m, l]) => (
                        <option key={m} value={m}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <span className="small">e, se não clicou, mandar:</span>
                  </div>
                  <textarea className="textarea" rows={2} value={followText} onChange={(e) => setFollowText(e.target.value)} />
                </>
              ) : (
                <span className="hint" style={{ color: 'var(--warning)' }}>
                  Adicione um botão de link na mensagem acima para usar o lembrete.
                </span>
              ))}
          </Section>

          <div className="field">
            <label className="label">Nome da automação (opcional)</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Guia do Canva" maxLength={100} />
          </div>
        </div>

        <Preview
          showComment={mode === 'full'}
          keyword={keywords.split(',')[0]?.trim() || 'QUERO'}
          reply={replies.find((r) => r.trim())}
          opening={openingOn ? { text: openingText, button: openingButton } : null}
          lock={lock ? { text: lockedText, retry: retryLabel || LOCK_DEFAULTS.retry, profile: profileLabel || LOCK_DEFAULTS.profile } : null}
          email={email ? emailText : null}
          msg={{ text: msgText, image, links: validLinks.length ? validLinks : links.filter((l) => l.label.trim()) }}
          followUp={followUp && validLinks.length ? { minutes: followMinutes, text: followText } : null}
        />
      </div>

      {picker === 'media' && (
        <MediaPicker
          onClose={() => setPicker(null)}
          selected={target.kind === 'media' ? target.media_id : null}
          onPick={(id) => {
            setTarget({ kind: 'media', media_id: id });
            setPicker(null);
          }}
        />
      )}
      {picker === 'scheduled' && (
        <ScheduledPicker
          onClose={() => setPicker(null)}
          onPick={(p) => {
            setTarget({ kind: 'scheduled', post: p });
            setPicker(null);
          }}
        />
      )}
    </Modal>
  );
}

function Section({ n, title, toggle, children }: { n: number; title: string; toggle?: { on: boolean; set: (v: boolean) => void }; children: ReactNode }) {
  return (
    <div className={`qa-section ${toggle && !toggle.on ? 'off' : ''}`}>
      <div className="qa-head">
        <span className="qa-n">{n}</span>
        <b>{title}</b>
        <span className="spacer" />
        {toggle && (
          <label className="switch" title={toggle.on ? 'Desligar' : 'Ligar'}>
            <input type="checkbox" checked={toggle.on} onChange={(e) => toggle.set(e.target.checked)} />
            <span />
          </label>
        )}
      </div>
      <div className="qa-body">{children}</div>
    </div>
  );
}

/** Prévia da conversa como o cliente vê. */
function Preview(p: {
  showComment: boolean;
  keyword: string;
  reply?: string;
  opening: { text: string; button: string } | null;
  lock: { text: string; retry: string; profile: string } | null;
  email: string | null;
  msg: { text: string; image: string; links: { label: string }[] };
  followUp: { minutes: number; text: string } | null;
}) {
  const fill = (t: string) => t.replace(/\{\{\s*first_name\s*(\|[^}]*)?\}\}/g, 'Maria').replace(/\{\{[^}]*\}\}/g, '…');
  const label = FOLLOW_UP_OPTIONS.find(([m]) => m === p.followUp?.minutes)?.[1];
  return (
    <div className="qa-preview">
      <div className="label">Como o cliente vê</div>
      <div className="qa-phone">
        {p.showComment && (
          <div className="qa-comment">
            <b>maria.silva</b> {p.keyword}
            {p.reply && (
              <div className="qa-reply">
                ↳ <b>você</b> {p.reply}
              </div>
            )}
          </div>
        )}
        <div className="qa-dm-title">Direct</div>
        {p.opening && (
          <Bubble text={fill(p.opening.text)} buttons={[`${p.lock ? '🔒 ' : ''}${p.opening.button}`]} />
        )}
        {p.lock && (
          <>
            <div className="qa-note">Se não segue:</div>
            <Bubble text={fill(p.lock.text)} buttons={[p.lock.retry, p.lock.profile]} dim />
          </>
        )}
        {p.email && <Bubble text={fill(p.email)} chips={['Agora não']} />}
        {p.msg.image && <img className="qa-img" src={p.msg.image} alt="" />}
        <Bubble text={fill(p.msg.text) || '…'} buttons={p.msg.links.map((l) => `🔗 ${l.label}`)} />
        {p.followUp && (
          <>
            <div className="qa-note">Depois de {label}, se não clicou:</div>
            <Bubble text={fill(p.followUp.text)} buttons={p.msg.links.map((l) => `🔗 ${l.label}`)} />
          </>
        )}
      </div>
    </div>
  );
}

function Bubble({ text, buttons = [], chips = [], dim }: { text: string; buttons?: string[]; chips?: string[]; dim?: boolean }) {
  return (
    <div className={`qa-bubble ${dim ? 'dim' : ''}`}>
      <div className="qa-text">{text}</div>
      {buttons.map((b, i) => (
        <div key={i} className="qa-btn">
          {b}
        </div>
      ))}
      {chips.length > 0 && (
        <div className="qa-chips">
          {chips.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}
