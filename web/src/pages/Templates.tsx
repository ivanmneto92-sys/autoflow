import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { describeTrigger, TYPES, type TType } from '../lib/triggers';

export interface TemplateInput {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'url' | 'phone' | 'money' | 'keyword';
  placeholder?: string;
  help?: string;
  default?: string;
  required: boolean;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tags: string[];
  inputs: TemplateInput[];
  steps: string[];
  triggers: { type: TType; config: any }[];
}

interface Gallery {
  categories: Record<string, string>;
  templates: TemplateInfo[];
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function Templates() {
  const gallery = useLoad(() => api<Gallery>('/app/templates'), []);
  const [params, setParams] = useSearchParams();
  const cat = params.get('categoria') ?? 'all';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<TemplateInfo | null>(null);

  const all = gallery.data?.templates ?? [];
  const cats = gallery.data?.categories ?? {};
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of all) c[t.category] = (c[t.category] ?? 0) + 1;
    return c;
  }, [all]);
  const shown = all.filter((t) => {
    if (cat !== 'all' && t.category !== cat) return false;
    if (!q.trim()) return true;
    const hay = norm([t.name, t.description, ...t.tags, cats[t.category] ?? ''].join(' '));
    return norm(q)
      .split(/\s+/)
      .every((w) => hay.includes(w));
  });

  function setCat(c: string) {
    const p = new URLSearchParams(params);
    if (c === 'all') p.delete('categoria');
    else p.set('categoria', c);
    setParams(p, { replace: true });
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Modelos prontos</h1>
          <p className="muted">Escolha um fluxo pronto, responda poucas perguntas e ele já sai com seus dados. Depois é só ajustar no editor.</p>
        </div>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Buscar: pedido, sorteio, agenda…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="tpl-cats">
        <button className={cat === 'all' ? 'active' : ''} onClick={() => setCat('all')}>
          Todos <span className="muted">{all.length || ''}</span>
        </button>
        {Object.entries(cats).map(([k, label]) => (
          <button key={k} className={cat === k ? 'active' : ''} onClick={() => setCat(k)}>
            {label} <span className="muted">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      <ErrorBox error={gallery.error} />
      {gallery.loading && !gallery.data ? (
        <Loading />
      ) : !shown.length ? (
        <div className="card">
          <Empty title="Nenhum modelo encontrado" text="Tente outra palavra ou veja todas as categorias." />
        </div>
      ) : (
        <div className="tpl-grid">
          {shown.map((t) => (
            <button key={t.id} className="card tpl-card" onClick={() => setOpen(t)}>
              <div className="tpl-icon">{t.icon}</div>
              <div className="tpl-name">{t.name}</div>
              <div className="muted small tpl-desc">{t.description}</div>
              <div className="tpl-foot">
                <span className="badge">{cats[t.category]}</span>
                {t.triggers[0] && (
                  <span className="muted small">
                    {TYPES[t.triggers[0].type]?.icon} {TYPES[t.triggers[0].type]?.label}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && <UseTemplate t={open} category={cats[open.category] ?? ''} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Mostra o marcador [[chave]] como «Pergunta» na prévia dos gatilhos. */
function labelize(value: unknown, inputs: TemplateInput[]): any {
  if (typeof value === 'string') return value.replace(/\[\[([a-z0-9_]+)\]\]/g, (_m, k) => `«${inputs.find((i) => i.key === k)?.label ?? k}»`);
  if (Array.isArray(value)) return value.map((v) => labelize(v, inputs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, labelize(v, inputs)]));
  return value;
}

function UseTemplate({ t, category, onClose }: { t: TemplateInfo; category: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(t.name);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(t.inputs.map((i) => [i.key, i.default ?? ''])));
  const [withTriggers, setWithTriggers] = useState(true);
  const [busy, setBusy] = useState(false);
  const missing = t.inputs.filter((i) => i.required && !answers[i.key]?.trim());

  async function create() {
    if (missing.length) {
      toast(`Preencha: ${missing[0]!.label}`, true);
      return;
    }
    setBusy(true);
    try {
      const f = await api<{ id: string }>('/app/flows', {
        body: { name: name.trim() || t.name, template_id: t.id, inputs: answers, create_triggers: withTriggers && t.triggers.length > 0 },
      });
      toast(withTriggers && t.triggers.length ? 'Fluxo criado com os gatilhos. Revise e publique!' : 'Fluxo criado. Revise e publique!');
      nav(`/fluxos/${f.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`${t.icon} ${t.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? 'Criando…' : 'Criar fluxo e abrir editor'}
          </button>
        </>
      }
    >
      <div className="tpl-detail">
        <div className="stack">
          <div>
            <span className="badge">{category}</span>
            <p style={{ margin: '8px 0 0' }}>{t.description}</p>
          </div>
          <div>
            <div className="label">O que o fluxo faz</div>
            <ol className="tpl-steps">
              {t.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
          {t.triggers.length > 0 && (
            <div>
              <div className="label">Começa quando</div>
              <div className="stack-sm">
                {t.triggers.map((tr, i) => (
                  <div key={i} className="small">
                    {TYPES[tr.type]?.icon} <b>{TYPES[tr.type]?.label}</b>
                    <div className="muted">{describeTrigger({ type: tr.type, config: labelize(tr.config, t.inputs) })}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="field">
            <label className="label">Nome do fluxo</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          {t.inputs.map((i) => (
            <div className="field" key={i.key}>
              <label className="label">
                {i.label} {!i.required && <span className="muted small">(opcional)</span>}
              </label>
              {i.type === 'textarea' ? (
                <textarea
                  className="textarea"
                  rows={3}
                  value={answers[i.key] ?? ''}
                  placeholder={i.placeholder}
                  onChange={(e) => setAnswers({ ...answers, [i.key]: e.target.value })}
                />
              ) : (
                <input
                  className="input"
                  inputMode={i.type === 'phone' ? 'tel' : i.type === 'url' ? 'url' : i.type === 'money' ? 'decimal' : undefined}
                  value={answers[i.key] ?? ''}
                  placeholder={i.placeholder}
                  onChange={(e) => setAnswers({ ...answers, [i.key]: e.target.value })}
                />
              )}
              {(i.help || i.type === 'keyword') && (
                <div className="hint">{i.help ?? 'Separe várias palavras por vírgula.'}</div>
              )}
            </div>
          ))}
          {t.triggers.length > 0 && (
            <label className="checkbox">
              <input type="checkbox" checked={withTriggers} onChange={(e) => setWithTriggers(e.target.checked)} />
              Criar também os gatilhos (ficam ativos quando você publicar)
            </label>
          )}
          {!t.inputs.length && <p className="muted small">Este modelo não tem perguntas — é só criar e ajustar os textos no editor.</p>}
        </div>
      </div>
    </Modal>
  );
}
