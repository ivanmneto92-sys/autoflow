import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode } from '../shared/schema';
import { NODE_META, outputsOf, summarize } from './graph';

export function FlowNodeCard({ data, selected }: NodeProps) {
  const { node, hasError, count, isStart } = data as { node: FlowNode; hasError: boolean; count?: number; isStart: boolean };
  const meta = NODE_META[node.type];
  const outs = outputsOf(node);
  const text = summarize(node);
  return (
    <div className={`fnode ${selected ? 'selected' : ''} ${hasError ? 'has-error' : ''}`}>
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
      {text && <div className="fnode-body">{text}</div>}
      {node.type === 'message' && node.data.buttons?.some((b) => b.url) && (
        <div className="fnode-body" style={{ paddingTop: 0 }}>
          {node.data.buttons
            .filter((b) => b.url)
            .map((b, i) => (
              <div key={i}>🔗 {b.label}</div>
            ))}
        </div>
      )}
      {outs.length > 0 && (
        <div className="fnode-outs">
          {outs.map((o) => (
            <div className="fnode-out" key={o.id}>
              {o.label}
              <Handle type="source" position={Position.Right} id={o.id} style={{ top: '50%', right: -6 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StartNode() {
  return (
    <div className="fnode-start">
      ▶ Início
      <Handle type="source" position={Position.Right} id="start" />
    </div>
  );
}

export const nodeTypes = { flow: FlowNodeCard, start: StartNode };
