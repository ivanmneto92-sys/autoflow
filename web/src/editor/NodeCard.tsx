import { Handle, NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';
import { describeAutomation, type Post } from '../lib/posts';
import { describeTrigger, TYPES, type Trigger } from '../lib/triggers';
import type { FlowNode } from '../shared/schema';
import { mustConnect, NODE_META, outputsOf, summarize, type Output } from './graph';

/** Ações do editor usadas pelos cartões (duplicar / excluir pela barrinha em cima do nó). */
export const EditorActions = createContext<{ duplicate: (id: string) => void; remove: (id: string) => void } | null>(null);

/** Mensagem como ela chega: foto, texto inteiro e os botões dentro do balão (cada botão com a sua ligação). */
function MessageBody({ node, outs }: { node: Extract<FlowNode, { type: 'message' }>; outs: Output[] }) {
  const out = (id: string) => outs.find((o) => o.id === id);
  const img = node.data.image_url && /^https?:\/\/.+\..+/.test(node.data.image_url) ? node.data.image_url : '';
  return (
    <div className="fmsg">
      {img && <img className="fmsg-img" src={img} alt="" />}
      <div className="fmsg-text">{node.data.text}</div>
      {(node.data.buttons ?? []).map((b, i) => {
        const o = out(`btn-${i}`);
        return (
          <div key={`b${i}`} className={`fmsg-btn ${o && mustConnect(o) ? 'loose' : ''}`} title={o && mustConnect(o) ? 'Não está ligado: arraste a bolinha até o próximo passo' : undefined}>
            <span>{b.label}</span>
            <span className="fmsg-btn-icon">{b.followers_only ? '🔒' : b.url ? '🔗' : ''}</span>
            {o && <Handle type="source" position={Position.Right} id={o.id} className="fmsg-handle" />}
          </div>
        );
      })}
      {(node.data.quick_replies ?? []).length > 0 && (
        <div className="fmsg-qrs">
          {node.data.quick_replies!.map((q, i) => {
            const o = out(`qr-${i}`);
            return (
              <div key={`q${i}`} className={`fmsg-qr ${o && mustConnect(o) ? 'loose' : ''}`}>
                ⚡ {q.label}
                {o && <Handle type="source" position={Position.Right} id={o.id} className="fmsg-handle" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FlowNodeCard({ id, data, selected }: NodeProps) {
  const { node, hasError, hasWarning, count, isStart } = data as { node: FlowNode; hasError: boolean; hasWarning?: boolean; count?: number; isStart: boolean };
  const actions = useContext(EditorActions);
  const meta = NODE_META[node.type];
  const allOuts = outputsOf(node);
  // Na mensagem, botões e respostas rápidas saem de dentro do balão; embaixo fica só o "Próximo"
  const outs = node.type === 'message' ? allOuts.filter((o) => !/^(btn|qr)-/.test(o.id)) : allOuts;
  const text = node.type === 'message' ? '' : summarize(node);
  return (
    <div className={`fnode ${node.type === 'message' ? 'fnode-msg' : ''} ${selected ? 'selected' : ''} ${hasError ? 'has-error' : hasWarning ? 'has-warning' : ''}`}>
      {actions && (
        <NodeToolbar position={Position.Top} className="fnode-toolbar">
          <button className="nodrag" title="Duplicar (Ctrl+D)" onClick={() => actions.duplicate(id)}>
            ⧉
          </button>
          <button className="nodrag danger" title="Excluir (Delete)" onClick={() => actions.remove(id)}>
            🗑
          </button>
        </NodeToolbar>
      )}
      <Handle type="target" position={Position.Left} style={{ top: 20 }} />
      <div className="fnode-head">
        <span className="fnode-icon" style={{ background: meta.color }}>
          {meta.icon}
        </span>
        <span>{meta.label}</span>
        <span className="spacer" />
        {isStart && <span className="badge badge-primary">início</span>}
        {count !== undefined && <span className="badge">{count}×</span>}
      </div>
      {node.type === 'message' ? <MessageBody node={node} outs={allOuts} /> : text && <div className="fnode-body">{text}</div>}
      {outs.length > 0 && (
        <div className="fnode-outs">
          {outs.map((o) => (
            <div className={`fnode-out ${mustConnect(o) ? 'loose' : ''}`} key={o.id} title={mustConnect(o) ? 'Não está ligado: arraste a bolinha até o próximo passo' : undefined}>
              {mustConnect(o) && <span className="loose-tag">⚠ solto</span>}
              {o.label}
              <Handle type="source" position={Position.Right} id={o.id} style={{ top: '50%', right: -6 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Dados do nó "Quando…" (gatilhos do fluxo), passados pelo editor via contexto. */
export interface WhenInfo {
  triggers: Trigger[] | null;
  pending: Post[];
  onAdd: () => void;
  onEdit: (t: Trigger) => void;
}
export const WhenContext = createContext<WhenInfo | null>(null);

/** Primeiro nó do fluxo: os gatilhos que fazem ele começar. */
export function StartNode() {
  const w = useContext(WhenContext);
  const triggers = w?.triggers;
  const empty = triggers && !triggers.length && !w.pending.length;
  return (
    <div className={`fnode fnode-when ${empty ? 'has-error' : ''}`}>
      <div className="fnode-head">
        <span className="fnode-icon" style={{ background: '#f59e0b' }}>
          ⚡
        </span>
        <span>Quando…</span>
      </div>
      <div className="fnode-body when-body">
        {!triggers ? (
          <span className="muted">Carregando gatilhos…</span>
        ) : (
          <>
            {empty && <div className="muted">O gatilho é quem faz o fluxo começar. Adicione pelo menos um.</div>}
            {triggers.map((t) => (
              <button
                key={t.id}
                className={`when-item nodrag ${t.enabled ? '' : 'off'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  w.onEdit(t);
                }}
                title="Editar gatilho"
              >
                <span>{TYPES[t.type]?.icon}</span>
                <span className="when-text">{describeTrigger(t)}</span>
                {!t.enabled && <span className="badge">pausado</span>}
              </button>
            ))}
            {w.pending.map((p) => (
              <div key={p.id} className="when-item pending" title="Vira gatilho quando o post for publicado">
                <span>🗓</span>
                <span className="when-text">
                  {describeAutomation(p.automation!)} · post de {new Date(p.scheduled_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                </span>
              </div>
            ))}
            <button
              className="when-add nodrag"
              onClick={(e) => {
                e.stopPropagation();
                w.onAdd();
              }}
            >
              + Novo gatilho
            </button>
          </>
        )}
      </div>
      <div className="fnode-outs">
        <div className="fnode-out">
          Então
          <Handle type="source" position={Position.Right} id="start" style={{ top: '50%', right: -6 }} />
        </div>
      </div>
    </div>
  );
}

export const nodeTypes = { flow: FlowNodeCard, start: StartNode };
