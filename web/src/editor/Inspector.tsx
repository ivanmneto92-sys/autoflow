import type { ReactNode } from 'react';
import type { FlowNode } from '../shared/schema';
import { Icon } from '../components/ui';
import { NODE_META } from './graph';

type Props = {
  id: string;
  node: FlowNode;
  isStart: boolean;
  flows: { id: string; name: string }[];
  onChange: (n: FlowNode) => void;
  onDelete: () => void;
  onMakeStart: () => void;
  issues: string[];
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
            <div key={k} className="alert alert-danger small" style={{ marginBottom: 6 }}>
              {i}
            </div>
          ))}
        </div>
      )}

      <div className="inspector-section stack">
        {node.type === 'message' && <MessageForm node={node} set={set} />}

        {node.type === 'image' && (
          <Field label="URL da imagem" hint="Link público de uma imagem JPG ou PNG.">
            <input className="input" value={node.data.url} onChange={(e) => set((d) => (d.url = e.target.value))} />
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
                value={b.url !== undefined ? 'url' : 'flow'}
                onChange={(e) =>
                  set((d) => {
                    if (e.target.value === 'url') {
                      d.buttons[i].url = 'https://';
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
              </select>
              {b.url !== undefined && <input className="input" value={b.url} onChange={(e) => set((d) => (d.buttons[i].url = e.target.value))} />}
            </div>
          </div>
        ))}
      {mode === 'buttons' && node.data.buttons!.length < 3 && (
        <button className="btn btn-sm" onClick={() => set((d) => d.buttons.push({ label: `Opção ${d.buttons.length + 1}`, next: null }))}>
          <Icon name="plus" /> Botão
        </button>
      )}
      {mode === 'quick' &&
        node.data.quick_replies!.map((q, i) => (
          <div className="row" key={i}>
            <input className="input" value={q.label} maxLength={20} onChange={(e) => set((d) => (d.quick_replies[i].label = e.target.value))} />
            <button className="btn btn-ghost btn-sm" onClick={() => set((d) => d.quick_replies.splice(i, 1))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      {mode === 'quick' && node.data.quick_replies!.length < 13 && (
        <button className="btn btn-sm" onClick={() => set((d) => d.quick_replies.push({ label: 'Opção', next: null }))}>
          <Icon name="plus" /> Resposta rápida
        </button>
      )}
      {mode !== 'none' && (
        <p className="hint">
          Cada opção vira uma saída no nó. Ligue cada uma ao próximo passo. Numa resposta a comentário, coloque botões na 1ª mensagem: o Instagram só libera mais mensagens depois que o cliente interage.
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
          <input className="input" placeholder="URL da imagem (opcional)" value={c.image_url ?? ''} onChange={(e) => set((d) => (d.cards[ci].image_url = e.target.value || undefined))} />
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
