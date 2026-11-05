import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { validateGraph, type FlowGraph, type FlowNode, type GraphIssue } from '../shared/schema';
import { FlowPostsModal } from '../components/FlowPostsModal';
import { Icon, Loading, useToast } from '../components/ui';
import { NODE_META, PALETTE, START_ID, autoLayout, newNode, removeNode, setOutput, toCanvas, uniqueId, type NodeType } from '../editor/graph';
import { Inspector } from '../editor/Inspector';
import { nodeTypes } from '../editor/NodeCard';
import { api, timeAgo } from '../lib/api';

interface FlowRow {
  id: string;
  name: string;
  status: string;
  draft_graph: FlowGraph;
  published_version: number | null;
  published_graph: FlowGraph | null;
  updated_at: string;
}

export function FlowEditor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

function EditorInner() {
  const { id } = useParams();
  const toast = useToast();
  const rf = useReactFlow();
  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [publishing, setPublishing] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showPosts, setShowPosts] = useState(false);
  const [stats, setStats] = useState<Record<string, number> | undefined>();
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<{ graph: FlowGraph | null; name: string }>({ graph: null, name: '' });

  useEffect(() => {
    api<FlowRow>(`/app/flows/${id}`)
      .then((f) => {
        const g = f.draft_graph ?? { start: '', nodes: {} };
        if (!g.layout) g.layout = autoLayout(g);
        setFlow(f);
        setGraph(g);
        setName(f.name);
        latest.current = { graph: g, name: f.name };
      })
      .catch((e) => setLoadError(e.message));
    api<{ id: string; name: string }[]>('/app/flows').then((l) => setFlows(l.filter((f) => f.id !== id)));
  }, [id]);

  const save = useCallback(async () => {
    setSaveState('saving');
    try {
      await api(`/app/flows/${id}`, { method: 'PUT', body: { name: latest.current.name, graph: latest.current.graph } });
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      toast((e as Error).message, true);
    }
  }, [id, toast]);

  const update = useCallback(
    (g: FlowGraph, newName?: string) => {
      setGraph(g);
      latest.current = { graph: g, name: newName ?? latest.current.name };
      setSaveState('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(save, 900);
    },
    [save],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  const { issues, errorsByNode } = useMemo(() => {
    if (!graph) return { issues: [] as GraphIssue[], errorsByNode: new Map<string, string[]>() };
    const { issues } = validateGraph(graph);
    const map = new Map<string, string[]>();
    for (const i of issues) {
      const nodeId = i.node ?? i.message.match(/^nodes\.([^.]+)\./)?.[1];
      if (nodeId && i.level === 'error') map.set(nodeId, [...(map.get(nodeId) ?? []), i.message.replace(/^nodes\.[^.]+\./, '')]);
    }
    return { issues, errorsByNode: map };
  }, [graph]);

  const canvas = useMemo(
    () => (graph ? toCanvas(graph, { selected, errors: new Set(errorsByNode.keys()), stats: showStats ? stats : undefined }) : { nodes: [], edges: [] }),
    [graph, selected, errorsByNode, showStats, stats],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!graph) return;
      let g = graph;
      let changed = false;
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          g = { ...g, layout: { ...(g.layout ?? {}), [c.id]: { x: Math.round(c.position.x), y: Math.round(c.position.y) } } };
          changed = true;
        } else if (c.type === 'remove' && c.id !== START_ID) {
          g = removeNode(g, c.id);
          changed = true;
          if (selected === c.id) setSelected(null);
        } else if (c.type === 'select') {
          if (c.selected && c.id !== START_ID) setSelected(c.id);
        }
      }
      if (changed) update(g);
    },
    [graph, selected, update],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!graph) return;
      let g = graph;
      let changed = false;
      for (const c of changes) {
        if (c.type !== 'remove') continue;
        const [source, handle] = c.id.split(':') as [string, string];
        if (source === START_ID) continue;
        const node = g.nodes[source];
        if (!node) continue;
        g = { ...g, nodes: { ...g.nodes, [source]: setOutput(node, handle, null) } };
        changed = true;
      }
      if (changed) update(g);
    },
    [graph, update],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!graph || !c.source || !c.target || c.target === START_ID || c.source === c.target) return;
      if (c.source === START_ID) return update({ ...graph, start: c.target });
      const node = graph.nodes[c.source];
      if (!node || !c.sourceHandle) return;
      update({ ...graph, nodes: { ...graph.nodes, [c.source]: setOutput(node, c.sourceHandle, c.target) } });
    },
    [graph, update],
  );

  function addNode(type: NodeType) {
    if (!graph) return;
    const nid = uniqueId(graph, type);
    const layout = { ...autoLayout(graph), ...(graph.layout ?? {}) };
    const g: FlowGraph = {
      ...graph,
      start: graph.nodes[graph.start] ? graph.start : nid,
      nodes: { ...graph.nodes, [nid]: newNode(type) },
      layout: { ...layout },
    };
    // Posição preferida: à direita do nó selecionado; sem seleção, à direita do nó mais à direita
    let pref: { x: number; y: number };
    const selPos = selected ? layout[selected] : undefined;
    if (selPos) pref = { x: selPos.x + 340, y: selPos.y };
    else {
      const ps = Object.entries(layout).filter(([k]) => k !== START_ID && graph.nodes[k]).map(([, v]) => v);
      pref = ps.length ? { x: Math.max(...ps.map((p) => p.x)) + 340, y: Math.min(...ps.map((p) => p.y)) } : { x: 240, y: 60 };
    }
    // Desce até achar um espaço livre (sem sobrepor outro nó)
    const busy = (x: number, y: number) =>
      Object.entries(layout).some(([k, p]) => k !== START_ID && Math.abs(p.x - x) < 290 && Math.abs(p.y - y) < 230);
    while (busy(pref.x, pref.y)) pref = { x: pref.x, y: pref.y + 240 };
    g.layout![nid] = pref;

    // Se um nó está selecionado e a saída "next" dele está livre, já liga
    if (selected && g.nodes[selected]) {
      const sel = g.nodes[selected] as any;
      if ('next' in sel && !sel.next && !['condition', 'randomizer', 'goto_flow', 'end'].includes(sel.type)) {
        g.nodes[selected] = setOutput(sel, 'next', nid);
      }
    }
    update(g);
    setSelected(nid);
    // Leva a tela até o nó novo
    setTimeout(() => rf.setCenter(pref.x + 120, pref.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 400 }), 50);
  }

  async function publish() {
    clearTimeout(timer.current);
    await save();
    setPublishing(true);
    try {
      const r = await api<{ version: { version: number } }>(`/app/flows/${id}/publish`, { body: {} });
      setFlow((f) => (f ? { ...f, status: 'published', published_version: r.version.version, published_graph: structuredClone(latest.current.graph) } : f));
      toast(`Publicado! Versão ${r.version.version} já está valendo.`);
    } catch (e) {
      toast((e as Error).message, true);
    }
    setPublishing(false);
  }

  async function toggleStats() {
    if (!showStats) {
      const s = await api<{ nodes: { node_id: string; type: string; count: number }[] }>(`/app/flows/${id}/stats?days=30`);
      const m: Record<string, number> = {};
      for (const n of s.nodes) if (n.type === 'node_executed') m[n.node_id] = n.count;
      setStats(m);
    }
    setShowStats(!showStats);
  }

  if (loadError)
    return (
      <div className="page">
        <div className="alert alert-danger">{loadError}</div>
      </div>
    );
  if (!graph || !flow) return <Loading />;

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const selNode: FlowNode | undefined = selected ? graph.nodes[selected] : undefined;
  const changedSincePublish = flow.published_graph ? stable(stripLayout(flow.published_graph)) !== stable(stripLayout(validateGraph(graph).graph ?? graph)) : true;

  return (
    <div className="editor">
      <div className="editor-top">
        <Link to="/fluxos" className="btn btn-ghost btn-sm">
          <Icon name="back" /> Fluxos
        </Link>
        <input
          className="input"
          style={{ maxWidth: 320, fontWeight: 600 }}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            update(graph, e.target.value);
          }}
        />
        {flow.status === 'published' ? (
          <span className={`badge ${changedSincePublish ? 'badge-warning' : 'badge-success'}`}>
            {changedSincePublish ? `v${flow.published_version} publicada · alterações não publicadas` : `Publicado v${flow.published_version}`}
          </span>
        ) : (
          <span className="badge">Rascunho</span>
        )}
        <span className="spacer" />
        <span className="muted small">
          {saveState === 'saving' ? 'Salvando…' : saveState === 'dirty' ? 'Alterações pendentes' : saveState === 'error' ? 'Erro ao salvar' : `Salvo ${timeAgo(flow.updated_at) === 'agora' ? '' : ''}`}
        </span>
        <Link to="/simulador" className="btn btn-sm" title="Testar os fluxos publicados no simulador">
          <Icon name="play" /> Testar
        </Link>
        <button className="btn btn-sm" onClick={() => setShowPosts(true)} title="Ligar este fluxo aos comentários de uma publicação agendada">
          <Icon name="calendar" /> Usar numa publicação
        </button>
        <button className={`btn btn-sm ${showStats ? 'btn-primary' : ''}`} onClick={toggleStats}>
          Métricas
        </button>
        {errorCount > 0 && (
          <span className="badge badge-danger" title={issues.map((i) => i.message).join('\n')}>
            {errorCount} erro(s)
          </span>
        )}
        <button className="btn btn-primary" onClick={publish} disabled={publishing || errorCount > 0}>
          {publishing ? 'Publicando…' : 'Publicar'}
        </button>
      </div>
      <div className="editor-body">
        <div className="palette">
          <div className="label" style={{ marginBottom: 8 }}>
            Adicionar
          </div>
          {PALETTE.map((t) => (
            <div key={t} className="palette-item" onClick={() => addNode(t)} title={NODE_META[t].hint}>
              <span className="fnode-icon" style={{ background: NODE_META[t].color }}>
                {NODE_META[t].icon}
              </span>
              {NODE_META[t].label}
            </div>
          ))}
          <p className="hint" style={{ marginTop: 10 }}>
            Clique para adicionar. Com um nó selecionado, o novo já entra ligado a ele.
          </p>
        </div>
        <div className="canvas">
          <ReactFlow
            nodes={canvas.nodes}
            edges={canvas.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={(event, conn) => {
              // Soltar a linha em qualquer parte de um nó também liga (não só na bolinha)
              if (conn.isValid || !conn.fromNode || !conn.fromHandle) return;
              const pt = 'changedTouches' in event ? event.changedTouches[0]! : (event as MouseEvent);
              const el = document.elementFromPoint(pt.clientX, pt.clientY)?.closest('.react-flow__node');
              const target = el?.getAttribute('data-id');
              if (target && target !== conn.fromNode.id)
                onConnect({ source: conn.fromNode.id, sourceHandle: conn.fromHandle.id ?? null, target, targetHandle: null });
            }}
            connectionRadius={40}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            deleteKeyCode={['Delete', 'Backspace']}
            minZoom={0.2}
            colorMode="system"
          >
            <Background gap={18} color="var(--border)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ height: 90, width: 140 }} nodeColor={(n) => (n.type === 'start' ? '#5b5bd6' : (NODE_META[(n.data as any)?.node?.type as NodeType]?.color ?? '#999'))} />
          </ReactFlow>
        </div>
        <div className="inspector">
          {selNode && selected ? (
            <Inspector
              key={selected}
              id={selected}
              node={selNode}
              isStart={graph.start === selected}
              flows={flows}
              issues={errorsByNode.get(selected) ?? []}
              onChange={(n) => update({ ...graph, nodes: { ...graph.nodes, [selected]: n } })}
              onDelete={() => {
                update(removeNode(graph, selected));
                setSelected(null);
              }}
              onMakeStart={() => update({ ...graph, start: selected })}
            />
          ) : (
            <div className="inspector-section stack">
              <h3>Como funciona</h3>
              <p className="muted">
                O fluxo começa no <b>▶ Início</b> e segue as ligações. Clique num nó para editar. Arraste da bolinha à direita de uma saída até outro nó para ligar.
              </p>
              <p className="muted">
                As alterações são salvas sozinhas, mas só passam a valer para os clientes depois de <b>Publicar</b>. Conversas em andamento continuam na versão anterior.
              </p>
              <p className="muted">
                Para o fluxo rodar, ele precisa de um <Link to="/gatilhos">gatilho</Link> (palavra-chave, comentário, story…).
              </p>
              {issues.length > 0 && (
                <div className="stack-sm">
                  <div className="label">Avisos</div>
                  {issues.map((i, k) => (
                    <div
                      key={k}
                      className={`alert ${i.level === 'error' ? 'alert-danger' : 'alert-warning'} small`}
                      style={{ cursor: i.node ? 'pointer' : undefined }}
                      onClick={() => i.node && setSelected(i.node)}
                    >
                      {i.node && <b>{i.node}: </b>}
                      {i.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {showPosts && <FlowPostsModal flowId={flow.id} flowPublished={flow.status === 'published'} onClose={() => setShowPosts(false)} />}
    </div>
  );
}

/** JSON com chaves ordenadas (o banco reordena as chaves do JSON). */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))) : val,
  );
}

function stripLayout(g: FlowGraph) {
  const { layout: _l, ...rest } = g;
  return rest;
}
