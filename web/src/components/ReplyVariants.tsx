/** Respostas públicas no comentário: cada caixa é uma resposta completa (pode ter várias linhas); o robô sorteia uma. */
import { Icon } from './ui';

export function ReplyVariants({ value, onChange, max = 10 }: { value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const list = value.length ? value : [''];
  return (
    <div className="stack-sm">
      {list.map((r, i) => (
        <div className="row" key={i}>
          <textarea
            className="textarea"
            rows={r.includes('\n') ? 3 : 1}
            style={{ minHeight: r.includes('\n') ? 76 : 42, resize: 'vertical' }}
            value={r}
            placeholder="Ex.: Te mandei no Direct! 📩"
            onChange={(e) => onChange(list.map((x, k) => (k === i ? e.target.value : x)))}
          />
          {list.length > 1 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(list.filter((_, k) => k !== i))} title="Remover">
              <Icon name="x" />
            </button>
          )}
        </div>
      ))}
      {list.length < max && (
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...list, ''])}>
          <Icon name="plus" /> Outra versão
        </button>
      )}
      <span className="hint">Cada caixa é uma resposta completa (pode ter várias linhas). Com mais de uma, o robô sorteia — fica mais natural.</span>
    </div>
  );
}
