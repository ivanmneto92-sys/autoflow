import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, useLoad, useToast } from '../components/ui';
import { api, apiUpload } from '../lib/api';
import { prepareImage } from '../lib/image';
import { LOCK_DEFAULTS, type FlowNode } from '../shared/schema';
import { NODE_META } from './graph';

type Props = {
  id: string;
  node: FlowNode;
  isStart: boolean;
  flows: { id: string; name: string }[];
  onChange: (n: FlowNode) => void;
  onDelete: () => void;
  onMakeStart: () => void;
  issues: { level: 'error' | 'warning'; message: string }[];
};

const VARS = ['{{first_name}}', '{{username}}', '{{field.nome}}', '{{first_name|amigo}}'];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function TextArea({ value, onChange, max = 1000 }: { value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <>
      <textarea className="textarea" value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      <div className="row-between">
        <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
          {VARS.map((v) => (
            <button key={v} type="button" className="chip" onClick={() => onChange(value + v)} title="Inserir variável">
              {v}
            </button>
          ))}
        </div>
        <span className="hint">
          {value.length}/{max}
        </span>
      </div>
    </>
  );
}

export function Inspector({ id, node, isStart, flows, onChange, onDelete, onMakeStart, issues }: Props) {
  const meta = NODE_META[node.type];
  const set = (fn: (d: any) => void) => {
    const n = structuredClone(node) as any;
    fn(n.data);
    onChange(n);
  };

  return (
    <div>
      <div className="inspector-section row-between">
        <div className="row">
          <span className="fnode-icon" style={{ background: meta.color }}>
            {meta.icon}
          </span>
          <div>
            <h3>{meta.label}</h3>
            <div className="muted small mono">{id}</div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm btn-danger" onClick={onDelete} title="Excluir nó">
          <Icon name="trash" />
        </button>
      </div>

      {issues.length > 0 && (
        <div className="inspector-section">
          {issues.map((i, k) => (
            <div key={k} className={`alert ${i.level === 'error' ? 'alert-danger' : 'alert-warning'} small`} style={{ marginBottom: 6 }}>
              {i.message}
            </div>
          ))}
        </div>
      )}

      <div className="inspector-section stack">
        {node.type === 'message' && <MessageForm node={node} set={set} />}

        {node.type === 'image' && (
          <Field label="Foto" hint="Envie do computador ou cole um link público (JPG/PNG).">
            <ImagePicker value={node.data.url} onChange={(url) => set((d) => (d.url = url))} />
          </Field>
        )}

        {node.type === 'carousel' && <CarouselForm node={node} set={set} />}

        {node.type === 'ask' && (
          <>
            <Field label="Pergunta">
              <TextArea value={node.data.text} onChange={(v) => set((d) => (d.text = v))} />
            </Field>
            <Field label="Salvar a resposta no campo" hint={<>Use depois como <span className="mono">{`{{field.${node.data.save_to || 'campo'}}}`}</span></>}>
              <input
                className="input mono"
                value={node.data.save_to}
                onChange={(e) => set((d) => (d.save_to = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')))}
              />
            </Field>
            <Field label="Tipo de resposta">
              <select className="select" value={node.data.validate} onChange={(e) => set((d) => (d.validate = e.target.value))}>
                <option value="text">Texto livre</option>
                <option value="email">E-mail</option>
                <option value="phone">Telefone</option>
                <option value="number">Número</option>
              </select>
            </Field>
            {node.data.validate !== 'text' && (
              <>
                <Field label="Mensagem quando a resposta for inválida" hint="Deixe vazio para usar a padrão.">
                  <input className="input" value={node.data.retry_text ?? ''} onChange={(e) => set((d) => (d.retry_text = e.target.value || undefined))} />
                </Field>
                <Field label="Tentativas antes de desistir">
                  <input className="input" type="number" min={0} max={5} value={node.data.max_retries} onChange={(e) => set((d) => (d.max_retries = Number(e.target.value)))} />
                </Field>
              </>
            )}
            <Field label="Sugestões para tocar (opcional)" hint="Separe por vírgula. A pessoa pode tocar numa delas ou digitar outra resposta.">
              <input
                className="input"
                value={(node.data.options ?? []).join(', ')}
                placeholder="ex.: P, M, G"
                onChange={(e) =>
                  set((d) => {
                    const o = e.target.value.split(',').map((x: string) => x.trimStart().slice(0, 20));
                    if (o.some((x: string) => x.trim())) d.options = o;
                    else delete d.options;
                  })
                }
                onBlur={() => set((d) => d.options && (d.options = d.options.map((x: string) => x.trim()).filter(Boolean)))}
              />
            </Field>
            <label className="checkbox small">
              <input type="checkbox" checked={Boolean(node.data.skip_label)} onChange={(e) => set((d) => (e.target.checked ? (d.skip_label = 'Pular') : delete d.skip_label))} />
              Botão “Pular” (segue sem responder)
            </label>
            {node.data.skip_label && (
              <input className="input" maxLength={20} value={node.data.skip_label} onChange={(e) => set((d) => (d.skip_label = e.target.value))} />
            )}
            <Field label="Lembrar se não responder (opcional)" hint="Manda 1 lembrete depois desse tempo, sem sair da pergunta.">
              <select
                className="select"
                value={node.data.reminder_minutes ?? ''}
                onChange={(e) =>
                  set((d) => {
                    if (e.target.value) d.reminder_minutes = Number(e.target.value);
                    else {
                      delete d.reminder_minutes;
                      delete d.reminder_text;
                    }
                  })
                }
              >
                <option value="">Não lembrar</option>
                <option value="15">Depois de 15 min</option>
                <option value="60">Depois de 1 hora</option>
                <option value="180">Depois de 3 horas</option>
                <option value="720">Depois de 12 horas</option>
              </select>
            </Field>
            {node.data.reminder_minutes && (
              <Field label="Texto do lembrete">
                <TextArea value={node.data.reminder_text ?? `Ainda está aí? 😊 ${node.data.text}`} onChange={(v) => set((d) => (d.reminder_text = v))} />
              </Field>
            )}
            <Field label="Esperar a resposta por (minutos)" hint="Vazio = espera para sempre. Com tempo, aparece a saída “Não respondeu”.">
              <input
                className="input"
                type="number"
                min={1}
                value={node.data.timeout_minutes ?? ''}
                onChange={(e) => set((d) => (d.timeout_minutes = e.target.value ? Number(e.target.value) : undefined))}
              />
            </Field>
          </>
        )}

        {node.type === 'follow_gate' && (
          <>
            <div className="alert alert-info small">
              A Meta só informa se a pessoa segue <b>depois que ela toca num botão ou escreve</b>. Por isso este bloco pede um toque, confere e só segue
              para quem segue. Quem não segue recebe o pedido para seguir e o botão para tentar de novo — ninguém fica sem resposta.
            </div>
            <Field label="Mensagem pedindo o toque" hint="Vai como a primeira mensagem (por exemplo, a resposta ao comentário).">
              <TextArea value={node.data.text} onChange={(v) => set((d) => (d.text = v))} />
            </Field>
            <Field label="Texto do botão">
              <input className="input" maxLength={20} value={node.data.button} onChange={(e) => set((d) => (d.button = e.target.value))} />
            </Field>
            <Field label="Mensagem para quem ainda não segue">
              <TextArea value={node.data.not_following_text} onChange={(v) => set((d) => (d.not_following_text = v))} />
            </Field>
            <Field label="Botão para tentar de novo" hint="Junto vai um botão “Abrir perfil” com o link do seu Instagram.">
              <input className="input" maxLength={20} value={node.data.retry_button} onChange={(e) => set((d) => (d.retry_button = e.target.value))} />
            </Field>
            <span className="hint">
              Ligue a saída <b>✅ Segue</b> ao conteúdo (mensagem com o link, cupom etc.). Quem já segue e já tinha conversado recebe direto, sem precisar tocar.
            </span>
          </>
        )}

        {node.type === 'condition' && <ConditionForm node={node} set={set} />}
        {node.type === 'action' && <ActionForm node={node} set={set} />}

        {node.type === 'delay' && (
          <Field label="Esperar (minutos)" hint="Máximo de 23h. Fora da janela de 24h o Instagram não deixa enviar.">
            <input className="input" type="number" min={0.1} step={1} value={node.data.minutes} onChange={(e) => set((d) => (d.minutes = Number(e.target.value)))} />
          </Field>
        )}

        {node.type === 'randomizer' && (
          <>
            {node.data.branches.map((b, i) => (
              <div className="row" key={i}>
                <span style={{ width: 22, fontWeight: 700 }}>{String.fromCharCode(65 + i)}</span>
                <input className="input" type="number" min={1} value={b.weight} onChange={(e) => set((d) => (d.branches[i].weight = Number(e.target.value)))} />
                <span className="muted small">peso</span>
                {node.data.branches.length > 2 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.branches.splice(i, 1))}>
                    <Icon name="x" />
                  </button>
                )}
              </div>
            ))}
            <button className="btn btn-sm" onClick={() => set((d) => d.branches.push({ weight: 50, next: null }))}>
              <Icon name="plus" /> Caminho
            </button>
          </>
        )}

        {node.type === 'goto_flow' && (
          <Field label="Fluxo de destino" hint="O fluxo precisa estar publicado.">
            <select className="select" value={node.data.flow_id} onChange={(e) => set((d) => (d.flow_id = e.target.value))}>
              <option value="00000000-0000-0000-0000-000000000000">Escolha…</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {node.type === 'end' && <p className="muted">Este nó encerra a conversa automática.</p>}
        {node.type === 'charge' && <ChargeForm node={node} set={set} />}
      </div>

      {!isStart && (
        <div className="inspector-section">
          <button className="btn btn-sm" onClick={onMakeStart}>
            ▶ Definir como início do fluxo
          </button>
        </div>
      )}
      <div className="inspector-section muted small">
        Para ligar este nó a outro, arraste da bolinha à direita de uma saída até o próximo nó. Para desligar, clique na linha e aperte Delete.
      </div>
    </div>
  );
}

function MessageForm({ node, set }: { node: Extract<FlowNode, { type: 'message' }>; set: (fn: (d: any) => void) => void }) {
  const mode = node.data.buttons?.length ? 'buttons' : node.data.quick_replies?.length ? 'quick' : 'none';
  return (
    <>
      <Field label="Texto">
        <TextArea value={node.data.text} onChange={(v) => set((d) => (d.text = v))} />
      </Field>
      <Field label="Foto antes do texto (opcional)" hint="Conta como 1 mensagem a mais — evite na 1ª mensagem de um fluxo de comentário.">
        <ImagePicker optional value={node.data.image_url ?? ''} onChange={(url) => set((d) => (url ? (d.image_url = url) : delete d.image_url))} />
      </Field>
      <Field label="Opções para o cliente">
        <select
          className="select"
          value={mode}
          onChange={(e) =>
            set((d) => {
              delete d.buttons;
              delete d.quick_replies;
              if (e.target.value === 'buttons') d.buttons = [{ label: 'Opção 1', next: null }];
              if (e.target.value === 'quick') d.quick_replies = [{ label: 'Sim', next: null }, { label: 'Não', next: null }];
            })
          }
        >
          <option value="none">Nenhuma (só texto)</option>
          <option value="buttons">Botões (até 3, aceitam link)</option>
          <option value="quick">Respostas rápidas (até 13)</option>
        </select>
      </Field>
      {mode === 'buttons' &&
        node.data.buttons!.map((b, i) => (
          <div key={i} className="card" style={{ padding: 10 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <input className="input" value={b.label} maxLength={20} onChange={(e) => set((d) => (d.buttons[i].label = e.target.value))} placeholder="Texto do botão" />
              <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.buttons.splice(i, 1))}>
                <Icon name="x" />
              </button>
            </div>
            <div className="row">
              <select
                className="select"
                value={b.url === undefined ? 'flow' : /^https:\/\/wa\.me\//.test(b.url) ? 'whatsapp' : 'url'}
                onChange={(e) =>
                  set((d) => {
                    if (e.target.value === 'url' || e.target.value === 'whatsapp') {
                      d.buttons[i].url =
                        e.target.value === 'whatsapp' ? 'https://wa.me/{{whatsapp}}?text=Olá! Vim pelo Instagram 😊' : 'https://';
                      delete d.buttons[i].next;
                    } else {
                      delete d.buttons[i].url;
                      d.buttons[i].next = null;
                    }
                  })
                }
                style={{ maxWidth: 130 }}
              >
                <option value="flow">Continua fluxo</option>
                <option value="url">Abre link</option>
                <option value="whatsapp">Abre WhatsApp</option>
              </select>
              {b.url !== undefined && !/^https:\/\/wa\.me\//.test(b.url) && (
                <input className="input" value={b.url} onChange={(e) => set((d) => (d.buttons[i].url = e.target.value))} />
              )}
            </div>
            {b.url !== undefined && /^https:\/\/wa\.me\//.test(b.url) && <WhatsAppButton url={b.url} onChange={(url) => set((d) => (d.buttons[i].url = url))} />}
            <label className="checkbox small" style={{ marginTop: 6 }}>
              <input
                type="checkbox"
                checked={Boolean(b.followers_only)}
                onChange={(e) =>
                  set((d) => {
                    if (e.target.checked) d.buttons[i].followers_only = true;
                    else delete d.buttons[i].followers_only;
                  })
                }
              />
              🔒 Só para seguidores
            </label>
            <ButtonActions actions={b.actions ?? []} onChange={(a) => set((d) => (a.length ? (d.buttons[i].actions = a) : delete d.buttons[i].actions))} isLink={b.url !== undefined} />
          </div>
        ))}
      {mode === 'buttons' && node.data.buttons!.some((b) => b.followers_only) && (
        <div className="card stack-sm" style={{ padding: 10, background: 'var(--surface-2)' }}>
          <div className="small">
            <b>🔒 Como funciona:</b> quem já segue e já falou com você (ou foi confirmado antes) recebe o botão normal — abre no 1º toque. Quem só
            comentou toca uma vez para o robô conferir: se segue, recebe na hora “{LOCK_DEFAULTS.ready_text}” com o link; se não segue, recebe a mensagem abaixo
            com <b>{LOCK_DEFAULTS.retry}</b> e <b>Abrir perfil</b>.
          </div>
          <Field label="Mensagem para quem não segue">
            <TextArea value={node.data.locked_text ?? LOCK_DEFAULTS.locked_text} onChange={(v) => set((d) => (d.locked_text = v))} />
          </Field>
          {node.data.buttons!.some((b) => b.followers_only && b.url) && (
            <Field label="Mensagem para quem acabou de seguir (vai junto com o link)">
              <TextArea value={node.data.unlocked_text ?? LOCK_DEFAULTS.unlocked_text} onChange={(v) => set((d) => (d.unlocked_text = v))} />
            </Field>
          )}
        </div>
      )}
      {mode === 'buttons' && node.data.buttons!.length < 3 && (
        <button className="btn btn-sm" onClick={() => set((d) => d.buttons.push({ label: `Opção ${d.buttons.length + 1}`, next: null }))}>
          <Icon name="plus" /> Botão
        </button>
      )}
      {mode === 'quick' &&
        node.data.quick_replies!.map((q, i) => (
          <div key={i} className="stack-sm">
            <div className="row">
              <input className="input" value={q.label} maxLength={20} onChange={(e) => set((d) => (d.quick_replies[i].label = e.target.value))} />
              <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.quick_replies.splice(i, 1))}>
                <Icon name="x" />
              </button>
            </div>
            <ButtonActions actions={q.actions ?? []} onChange={(a) => set((d) => (a.length ? (d.quick_replies[i].actions = a) : delete d.quick_replies[i].actions))} />
          </div>
        ))}
      {mode === 'quick' && node.data.quick_replies!.length < 13 && (
        <button className="btn btn-sm" onClick={() => set((d) => d.quick_replies.push({ label: 'Opção', next: null }))}>
          <Icon name="plus" /> Resposta rápida
        </button>
      )}
      {mode !== 'none' && (node.data.quick_replies?.length || node.data.buttons?.some((b) => b.url === undefined)) ? (
        <Field label="Salvar a opção escolhida no campo (opcional)" hint={node.data.save_to ? <>Fica em <span className="mono">{`{{field.${node.data.save_to}}}`}</span> — sem precisar de uma Ação para cada opção.</> : 'Ex.: area, interesse, tamanho.'}>
          <input
            className="input mono"
            value={node.data.save_to ?? ''}
            placeholder="ex.: interesse"
            onChange={(e) =>
              set((d) => {
                const v = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                if (v) d.save_to = v;
                else delete d.save_to;
              })
            }
          />
        </Field>
      ) : null}
      {mode !== 'none' && (
        <p className="hint">
          Cada opção que continua o fluxo vira uma saída no nó — ligue cada uma ao próximo passo. Em resposta a comentário, a Meta só libera a 2ª mensagem depois que a pessoa toca num botão ou responde.
        </p>
      )}
    </>
  );
}

function CarouselForm({ node, set }: { node: Extract<FlowNode, { type: 'carousel' }>; set: (fn: (d: any) => void) => void }) {
  return (
    <>
      {node.data.cards.map((c, ci) => (
        <div key={ci} className="card stack-sm" style={{ padding: 10 }}>
          <div className="row-between">
            <b>Cartão {ci + 1}</b>
            {node.data.cards.length > 1 && (
              <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.cards.splice(ci, 1))}>
                <Icon name="x" />
              </button>
            )}
          </div>
          <input className="input" placeholder="Título" maxLength={80} value={c.title} onChange={(e) => set((d) => (d.cards[ci].title = e.target.value))} />
          <input className="input" placeholder="Subtítulo (opcional)" maxLength={80} value={c.subtitle ?? ''} onChange={(e) => set((d) => (d.cards[ci].subtitle = e.target.value || undefined))} />
          <ImagePicker optional value={c.image_url ?? ''} onChange={(url) => set((d) => (d.cards[ci].image_url = url || undefined))} />
          {(c.buttons ?? []).map((b, i) => (
            <div className="row" key={i}>
              <input className="input" value={b.label} maxLength={20} onChange={(e) => set((d) => (d.cards[ci].buttons[i].label = e.target.value))} />
              <input
                className="input"
                placeholder="Link (vazio = continua fluxo)"
                value={b.url ?? ''}
                onChange={(e) =>
                  set((d) => {
                    const btn = d.cards[ci].buttons[i];
                    if (e.target.value) {
                      btn.url = e.target.value;
                      delete btn.next;
                    } else {
                      delete btn.url;
                      btn.next = null;
                    }
                  })
                }
              />
              <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.cards[ci].buttons.splice(i, 1))}>
                <Icon name="x" />
              </button>
            </div>
          ))}
          {(c.buttons?.length ?? 0) < 3 && (
            <button className="btn btn-sm" onClick={() => set((d) => (d.cards[ci].buttons = [...(d.cards[ci].buttons ?? []), { label: 'Ver mais', next: null }]))}>
              <Icon name="plus" /> Botão
            </button>
          )}
        </div>
      ))}
      {node.data.cards.length < 10 && (
        <button className="btn btn-sm" onClick={() => set((d) => d.cards.push({ title: 'Novo cartão', buttons: [] }))}>
          <Icon name="plus" /> Cartão
        </button>
      )}
    </>
  );
}

const COND_TYPES: [string, string][] = [
  ['business_hours', 'Está aberto agora (horário de funcionamento)'],
  ['is_new_contact', 'É um contato novo'],
  ['is_follower', 'Segue a conta no Instagram'],
  ['clicked_link', 'Clicou em algum link deste fluxo'],
  ['has_tag', 'Tem a tag'],
  ['field_exists', 'Campo preenchido'],
  ['field_equals', 'Campo igual a'],
  ['last_text_matches', 'Última mensagem contém'],
  ['var_equals', 'Variável igual a'],
];

function ConditionForm({ node, set }: { node: Extract<FlowNode, { type: 'condition' }>; set: (fn: (d: any) => void) => void }) {
  return (
    <>
      <p className="muted small">As regras são testadas na ordem. A primeira verdadeira decide o caminho; se nenhuma for, segue por “Senão”.</p>
      {node.data.rules.map((r, i) => {
        const w = r.when as any;
        return (
          <div key={i} className="card stack-sm" style={{ padding: 10 }}>
            <div className="row">
              <select
                className="select"
                value={w.type}
                onChange={(e) =>
                  set((d) => {
                    const t = e.target.value;
                    d.rules[i].when =
                      t === 'has_tag' ? { type: t, tag: '' }
                      : t === 'field_exists' ? { type: t, field: '' }
                      : t === 'field_equals' ? { type: t, field: '', value: '' }
                      : t === 'var_equals' ? { type: t, var: '', value: '' }
                      : t === 'last_text_matches' ? { type: t, keywords: [''], match: 'contains' }
                      : { type: t };
                  })
                }
              >
                {COND_TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {node.data.rules.length > 1 && (
                <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.rules.splice(i, 1))}>
                  <Icon name="x" />
                </button>
              )}
            </div>
            {w.type === 'clicked_link' && (
              <span className="hint">
                Conta os cliques nos botões de link deste fluxo (últimos 3 dias). Use depois de um <b>Atraso</b> para lembrar quem não clicou.
              </span>
            )}
            {w.type === 'is_follower' && (
              <span className="hint">
                A Meta só informa isso depois que a pessoa toca num botão ou escreve. Para fluxos de comentário, o mais simples é usar o bloco{' '}
                <b>🔒 Só seguidores</b> (na lista à esquerda). Se usar esta condição, ligue-a no botão de uma mensagem, nunca logo depois do comentário.
              </span>
            )}
            {'tag' in w && <input className="input" placeholder="nome-da-tag" value={w.tag} onChange={(e) => set((d) => (d.rules[i].when.tag = e.target.value))} />}
            {'field' in w && <input className="input mono" placeholder="campo (ex.: telefone)" value={w.field} onChange={(e) => set((d) => (d.rules[i].when.field = e.target.value))} />}
            {'var' in w && <input className="input mono" placeholder="variável" value={w.var} onChange={(e) => set((d) => (d.rules[i].when.var = e.target.value))} />}
            {'value' in w && <input className="input" placeholder="valor" value={w.value} onChange={(e) => set((d) => (d.rules[i].when.value = e.target.value))} />}
            {'keywords' in w && (
              <input
                className="input"
                placeholder="palavras separadas por vírgula"
                value={w.keywords.join(', ')}
                onChange={(e) => set((d) => (d.rules[i].when.keywords = e.target.value.split(',').map((s: string) => s.trim())))}
              />
            )}
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => set((d) => d.rules.push({ when: { type: 'is_new_contact' }, next: null }))}>
        <Icon name="plus" /> Regra
      </button>
    </>
  );
}

const ACTION_TYPES: [string, string][] = [
  ['add_tag', 'Adicionar tag'],
  ['remove_tag', 'Remover tag'],
  ['set_field', 'Preencher campo'],
  ['set_var', 'Definir variável'],
  ['human_handoff', 'Passar para atendente (pausa o robô)'],
  ['create_order', 'Registrar pedido (vai para Pedidos)'],
  ['give_coupon', 'Entregar cupom único'],
  ['webhook', 'Chamar webhook (n8n, sistema, Pix…)'],
];

function ActionForm({ node, set }: { node: Extract<FlowNode, { type: 'action' }>; set: (fn: (d: any) => void) => void }) {
  return (
    <>
      {node.data.actions.map((a: any, i) => (
        <div key={i} className="card stack-sm" style={{ padding: 10 }}>
          <div className="row">
            <select
              className="select"
              value={a.type}
              onChange={(e) =>
                set((d) => {
                  const t = e.target.value;
                  d.actions[i] =
                    t === 'add_tag' || t === 'remove_tag' ? { type: t, tag: '' }
                    : t === 'set_field' ? { type: t, field: '', value: '' }
                    : t === 'set_var' ? { type: t, var: '', value: '' }
                    : t === 'webhook' ? { type: t, url: 'https://', method: 'POST' }
                    : t === 'give_coupon' ? { type: t, campaign_id: '' }
                    : t === 'create_order' ? { type: t, summary: '{{field.pedido}}', fields: ['nome', 'endereco', 'telefone', 'pagamento'], total: '' }
                    : { type: t };
                })
              }
            >
              {ACTION_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {node.data.actions.length > 1 && (
              <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.actions.splice(i, 1))}>
                <Icon name="x" />
              </button>
            )}
          </div>
          {'tag' in a && <input className="input" placeholder="nome-da-tag" value={a.tag} onChange={(e) => set((d) => (d.actions[i].tag = e.target.value))} />}
          {'field' in a && <input className="input mono" placeholder="campo" value={a.field} onChange={(e) => set((d) => (d.actions[i].field = e.target.value))} />}
          {'var' in a && <input className="input mono" placeholder="variável" value={a.var} onChange={(e) => set((d) => (d.actions[i].var = e.target.value))} />}
          {'value' in a && <input className="input" placeholder="valor (aceita {{variáveis}})" value={a.value} onChange={(e) => set((d) => (d.actions[i].value = e.target.value))} />}
          {a.type === 'create_order' && (
            <>
              <label className="label" style={{ marginBottom: 0 }}>
                Resumo do pedido
              </label>
              <textarea
                className="input textarea"
                rows={2}
                value={a.summary}
                onChange={(e) => set((d) => (d.actions[i].summary = e.target.value))}
                placeholder="ex.: {{field.pedido}}"
              />
              <label className="label" style={{ marginBottom: 0 }}>
                Campos que vão junto (separados por vírgula)
              </label>
              <input
                className="input mono"
                value={a.fields.join(', ')}
                onChange={(e) => set((d) => (d.actions[i].fields = e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)))}
                placeholder="nome, endereco, telefone, pagamento"
              />
              <label className="label" style={{ marginBottom: 0 }}>
                Valor total (opcional)
              </label>
              <input
                className="input"
                value={a.total ?? ''}
                onChange={(e) => set((d) => (d.actions[i].total = e.target.value || undefined))}
                placeholder="ex.: 49,90 ou {{field.total}}"
              />
              <span className="hint">
                O pedido aparece na página <b>Pedidos</b> do painel, com som de aviso. O número dele fica em <span className="mono">{'{{var.order_number}}'}</span> para usar
                na mensagem seguinte.
              </span>
            </>
          )}
          {a.type === 'give_coupon' && <CouponPicker value={a.campaign_id} onChange={(v) => set((d) => (d.actions[i].campaign_id = v))} />}
          {a.type === 'webhook' && (
            <>
              <div className="row">
                <select className="select" style={{ maxWidth: 90 }} value={a.method} onChange={(e) => set((d) => (d.actions[i].method = e.target.value))}>
                  <option>POST</option>
                  <option>GET</option>
                </select>
                <input className="input" value={a.url} onChange={(e) => set((d) => (d.actions[i].url = e.target.value))} />
              </div>
              <input
                className="input mono"
                placeholder="salvar resposta na variável (opcional)"
                value={a.save_response_to ?? ''}
                onChange={(e) => set((d) => (d.actions[i].save_response_to = e.target.value || undefined))}
              />
              <span className="hint">
                Envia contato, tags, campos e variáveis em JSON. A resposta pode devolver <span className="mono">set_fields</span>, <span className="mono">set_vars</span> e{' '}
                <span className="mono">add_tags</span>.
              </span>
            </>
          )}
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => set((d) => d.actions.push({ type: 'add_tag', tag: '' }))}>
        <Icon name="plus" /> Ação
      </button>
    </>
  );
}

/** Escolhe a campanha de cupons e explica as variáveis. */
function CouponPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const camps = useLoad(() => api<{ id: string; name: string; discount: string; archived: boolean; mode: string; available: number }[]>('/app/coupons'), []);
  const list = (camps.data ?? []).filter((c) => !c.archived || c.id === value);
  const cur = list.find((c) => c.id === value);
  return (
    <>
      <label className="label" style={{ marginBottom: 0 }}>
        Campanha
      </label>
      {camps.data && !list.length ? (
        <div className="hint">
          Nenhuma campanha ainda. <Link to="/cupons">Crie uma na página Cupons</Link> e volte aqui.
        </div>
      ) : (
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Escolha…</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.discount ? ` — ${c.discount}` : ''}
              {c.mode === 'list' ? ` (${c.available} códigos livres)` : ''}
            </option>
          ))}
        </select>
      )}
      {cur?.mode === 'list' && cur.available === 0 && <div className="hint" style={{ color: 'var(--danger)' }}>Os códigos dessa lista acabaram. Adicione mais em Cupons.</div>}
      <span className="hint">
        Cada pessoa recebe um código só dela (se pedir de novo, recebe o mesmo). Use na mensagem seguinte:{' '}
        <span className="mono">{'{{var.coupon_code}}'}</span>, <span className="mono">{'{{var.coupon_discount}}'}</span> e{' '}
        <span className="mono">{'{{var.coupon_expires}}'}</span> (validade). Para tratar quem já tinha ou quando acabar, use uma Condição com a variável{' '}
        <span className="mono">coupon_status</span> = <span className="mono">ja_tinha</span> ou <span className="mono">esgotado</span>.
      </span>
    </>
  );
}

/** Botão "Abre WhatsApp": número do negócio (Configurações) ou outro, e a mensagem já preenchida. */
function WhatsAppButton({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const m = /^https:\/\/wa\.me\/([^?]*)\??(?:text=(.*))?$/s.exec(url);
  const phone = m?.[1] ?? '{{whatsapp}}';
  let text = m?.[2] ?? '';
  try {
    text = decodeURIComponent(text);
  } catch {
    /* já está cru */
  }
  const build = (p: string, t: string) => `https://wa.me/${p}${t ? `?text=${t}` : ''}`;
  const useBusiness = phone === '{{whatsapp}}';
  return (
    <div className="stack-sm">
      <label className="checkbox small">
        <input type="checkbox" checked={useBusiness} onChange={(e) => onChange(build(e.target.checked ? '{{whatsapp}}' : '', text))} />
        Usar o WhatsApp do negócio (Configurações)
      </label>
      {!useBusiness && (
        <input className="input mono" placeholder="5531999999999" value={phone} onChange={(e) => onChange(build(e.target.value.replace(/\D/g, ''), text))} />
      )}
      <textarea
        className="input textarea"
        rows={2}
        value={text}
        onChange={(e) => onChange(build(phone, e.target.value))}
        placeholder="Mensagem que já vai escrita (aceita {{field.nome}}, {{var.order_number}}…)"
      />
    </div>
  );
}

function ChargeForm({ node, set }: { node: Extract<FlowNode, { type: 'charge' }>; set: (fn: (d: any) => void) => void }) {
  const d = node.data;
  return (
    <>
      <div className="field">
        <label className="label">Valor</label>
        <input className="input" value={d.amount} onChange={(e) => set((x) => (x.amount = e.target.value))} placeholder="ex.: 49,90 ou {{field.total}}" />
        <span className="hint">Um valor fixo ou uma variável com o total do pedido.</span>
      </div>
      <div className="field">
        <label className="label">Descrição (aparece no extrato)</label>
        <input className="input" value={d.description} onChange={(e) => set((x) => (x.description = e.target.value))} maxLength={140} />
      </div>
      <div className="field">
        <label className="label">Mensagem antes do código</label>
        <textarea className="input textarea" rows={2} value={d.text} onChange={(e) => set((x) => (x.text = e.target.value))} />
        <span className="hint">Depois dela vai o valor, o botão “Ver QR Code” e o código copia-e-cola numa mensagem separada.</span>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Vence em (minutos)</label>
          <input
            className="input"
            type="number"
            min={5}
            max={1440}
            value={d.expires_minutes}
            onChange={(e) => set((x) => (x.expires_minutes = Math.max(5, Math.min(1440, Number(e.target.value) || 30))))}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Conta</label>
          <select className="select" value={d.provider ?? ''} onChange={(e) => set((x) => (x.provider = e.target.value || undefined))}>
            <option value="">Padrão do negócio</option>
            <option value="mercadopago">Mercado Pago</option>
            <option value="asaas">Asaas</option>
          </select>
        </div>
      </div>
      {d.provider !== 'mercadopago' && (
        <div className="field">
          <label className="label">CPF do cliente (obrigatório no Asaas)</label>
          <input className="input mono" value={d.cpf ?? ''} onChange={(e) => set((x) => (x.cpf = e.target.value || undefined))} placeholder="{{field.cpf}}" />
          <span className="hint">Peça o CPF antes com uma Pergunta (salvando em “cpf”). No Mercado Pago é opcional.</span>
        </div>
      )}
      <p className="hint">
        Saída <b>✅ Pagou</b>: o pagamento caiu (confirmação automática). Saída <b>⏰ Não pagou</b>: o Pix venceu. Se houver um pedido registrado antes, ele fica marcado
        como pago na página Pedidos. Conecte a conta de Pix em <b>Configurações</b>.
      </p>
    </>
  );
}

/** Foto: enviar do computador (vira JPG no formato do feed) ou colar um link. */
export function ImagePicker({ value, onChange, optional }: { value: string; onChange: (url: string) => void; optional?: boolean }) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  async function pick(file?: File) {
    if (!file) return;
    try {
      if (!file.type.startsWith('image/')) throw new Error('Escolha uma imagem (JPG ou PNG).');
      const { blob } = await prepareImage(file);
      setProgress(0);
      const up = await apiUpload(blob, setProgress);
      onChange(up.url);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setProgress(null);
    }
  }
  const shown = value && /^https?:\/\/.+\..+/.test(value) ? value : '';
  return (
    <div className="stack-sm">
      <div className="row">
        {shown && <img src={shown} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, flex: 'none' }} />}
        <label className="btn btn-sm" style={{ flex: 'none' }}>
          <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} disabled={progress !== null} />
          <Icon name="upload" size={15} /> {progress !== null ? `Enviando… ${Math.round(progress * 100)}%` : shown ? 'Trocar foto' : 'Enviar foto'}
        </label>
      </div>
      <input className="input" placeholder={optional ? 'ou cole o link da imagem (opcional)' : 'ou cole o link da imagem'} value={value === 'https://' ? '' : value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const BUTTON_ACTIONS: [string, string][] = [
  ['add_tag', 'Adicionar tag'],
  ['remove_tag', 'Remover tag'],
  ['set_field', 'Preencher campo'],
  ['human_handoff', 'Passar para atendente'],
];

/** Ações que rodam no toque do botão (sem precisar de um nó de Ação). */
function ButtonActions({ actions, onChange, isLink }: { actions: any[]; onChange: (a: any[]) => void; isLink?: boolean }) {
  const upd = (i: number, a: any) => onChange(actions.map((x, k) => (k === i ? a : x)));
  return (
    <div className="stack-sm" style={{ marginTop: 4 }}>
      {actions.map((a, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <select
            className="select"
            style={{ maxWidth: 150 }}
            value={a.type}
            onChange={(e) => {
              const t = e.target.value;
              upd(i, t === 'set_field' ? { type: t, field: '', value: '' } : t === 'human_handoff' ? { type: t } : { type: t, tag: '' });
            }}
          >
            {BUTTON_ACTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {'tag' in a && <input className="input" placeholder="tag" value={a.tag} onChange={(e) => upd(i, { ...a, tag: e.target.value })} />}
          {a.type === 'set_field' && (
            <>
              <input className="input mono" placeholder="campo" value={a.field} onChange={(e) => upd(i, { ...a, field: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
              <input className="input" placeholder="valor" value={a.value} onChange={(e) => upd(i, { ...a, value: e.target.value })} />
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => onChange(actions.filter((_, k) => k !== i))} title="Remover ação">
            <Icon name="x" />
          </button>
        </div>
      ))}
      {actions.length < 5 && (
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', padding: '2px 6px' }} onClick={() => onChange([...actions, { type: 'add_tag', tag: '' }])}>
          <Icon name="plus" size={14} /> Ação ao {isLink ? 'clicar' : 'tocar'}
        </button>
      )}
    </div>
  );
}
