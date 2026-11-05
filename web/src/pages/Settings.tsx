import { useState } from 'react';
import { useToast } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const DAYS: [string, string][] = [
  ['mon', 'Segunda'],
  ['tue', 'Terça'],
  ['wed', 'Quarta'],
  ['thu', 'Quinta'],
  ['fri', 'Sexta'],
  ['sat', 'Sábado'],
  ['sun', 'Domingo'],
];

type Hours = Record<string, [string, string][]>;

export function Settings() {
  const { workspace, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(workspace?.name ?? '');
  const [pause, setPause] = useState(workspace?.settings.bot_pause_hours ?? 12);
  const [hours, setHours] = useState<Hours>(workspace?.settings.business_hours ?? {});
  const [whatsapp, setWhatsapp] = useState(workspace?.settings.whatsapp ?? '');
  const [busy, setBusy] = useState(false);

  const setDay = (day: string, open: boolean) =>
    setHours((h) => {
      const n = { ...h };
      if (open) n[day] = [['18:00', '23:00']];
      else delete n[day];
      return n;
    });
  const setTime = (day: string, i: 0 | 1, v: string) =>
    setHours((h) => {
      const cur: [string, string] = [...(h[day]?.[0] ?? ['18:00', '23:00'])] as [string, string];
      cur[i] = v;
      return { ...h, [day]: [cur, ...(h[day]?.slice(1) ?? [])] };
    });

  async function save() {
    setBusy(true);
    try {
      await api('/app/workspace', { method: 'PATCH', body: { name, settings: { bot_pause_hours: Number(pause), business_hours: hours, whatsapp } } });
      await refresh();
      toast('Configurações salvas');
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  }

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-header">
        <div>
          <h1>Configurações</h1>
          <p className="muted">Dados do negócio e comportamento do robô.</p>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar'}
        </button>
      </div>

      <div className="card card-body stack" style={{ marginBottom: 14 }}>
        <div className="field">
          <label className="label">Nome do negócio</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">WhatsApp do negócio</label>
          <input
            className="input mono"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value.replace(/\D/g, ''))}
            placeholder="5531999999999"
            style={{ maxWidth: 220 }}
          />
          <span className="hint">Com DDI 55 e DDD, só números. É para onde vão os botões “Abre WhatsApp” dos fluxos.</span>
        </div>
        <div className="field">
          <label className="label">Pausar o robô depois que um atendente responde (horas)</label>
          <input className="input" type="number" min={0} max={168} value={pause} onChange={(e) => setPause(Number(e.target.value))} style={{ maxWidth: 140 }} />
          <span className="hint">Quando alguém da equipe responde (pela inbox ou pelo app do Instagram), o robô fica em silêncio com aquele cliente por esse tempo. 0 = nunca pausa.</span>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Horário de funcionamento</h3>
            <p className="muted small" style={{ marginTop: 2 }}>
              Usado pela condição "Está aberto agora?" nos fluxos. Sem nenhum dia marcado, o sistema considera sempre aberto. Para virar a noite, use um fechamento menor que a abertura (ex.: 18:00 → 02:00).
            </p>
          </div>
        </div>
        <table className="table">
          <tbody>
            {DAYS.map(([key, label]) => {
              const open = Boolean(hours[key]?.length);
              const [o, c] = hours[key]?.[0] ?? ['18:00', '23:00'];
              return (
                <tr key={key}>
                  <td style={{ width: 160 }}>
                    <label className="checkbox">
                      <input type="checkbox" checked={open} onChange={(e) => setDay(key, e.target.checked)} />
                      {label}
                    </label>
                  </td>
                  <td>
                    {open ? (
                      <div className="row">
                        <input className="input" type="time" value={o} onChange={(e) => setTime(key, 0, e.target.value)} style={{ maxWidth: 130 }} />
                        <span className="muted">até</span>
                        <input className="input" type="time" value={c} onChange={(e) => setTime(key, 1, e.target.value)} style={{ maxWidth: 130 }} />
                      </div>
                    ) : (
                      <span className="muted">Fechado</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
