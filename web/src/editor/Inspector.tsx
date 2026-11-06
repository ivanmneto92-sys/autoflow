import type { ReactNode } from 'react';
import type { FlowNode } from '../shared/schema';
import { Link } from 'react-router-dom';
import { Icon, useLoad } from '../components/ui';
import { api } from '../lib/api';
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
  ['is_follower', 'Segue a conta no Instagram'],
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
            {w.type === 'is_follower' && (
              <span className="hint">
                A Meta só informa isso depois que a pessoa interage. Em fluxos de comentário, coloque antes uma mensagem com botão (ex.: “Já te sigo ✅”) e
                ligue o botão nesta condição.
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
