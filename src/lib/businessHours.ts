export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
/** Ex.: { mon: [["11:00","15:00"],["18:00","23:30"]], ... } — "23:00"-"02:00" atravessa a meia-noite */
export type BusinessHours = Partial<Record<DayKey, [string, string][]>>;

const DAYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function localParts(now: Date, timezone: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  const hour = Number(parts.hour) % 24;
  return { day, minutes: hour * 60 + Number(parts.minute) };
}

export function isOpen(hours: BusinessHours | undefined, timezone: string, now = new Date()): boolean {
  if (!hours || Object.keys(hours).length === 0) return true; // sem horário configurado = sempre aberto
  const { day, minutes } = localParts(now, timezone);
  const today = hours[DAYS[day]!] ?? [];
  const yesterday = hours[DAYS[(day + 6) % 7]!] ?? [];

  for (const [o, c] of today) {
    const open = toMin(o);
    const close = toMin(c);
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  // Intervalos de ontem que passam da meia-noite
  for (const [o, c] of yesterday) {
    const open = toMin(o);
    const close = toMin(c);
    if (close <= open && minutes < close) return true;
  }
  return false;
}
