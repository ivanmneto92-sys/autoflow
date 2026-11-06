/**
 * IDs de mensagem (mid) da Meta: a mesma mensagem pode vir com codificações diferentes.
 * Ex.: a resposta do envio traz "new_ig_dm_item:1:IGMessageID:…" e o eco (webhook) traz "ig_dm_item:1:IGMessageID:…",
 * ambos em base64 com o "escape" da Meta (ZA→Z, ZB→+, ZC→/, ZD→=). Sem normalizar, o eco da mensagem do robô
 * parecia mensagem de um humano e pausava o robô.
 */
const ESC: Record<string, string> = { A: 'Z', B: '+', C: '/', D: '=' };

export function normalizeMid(mid: string | null | undefined): string | null {
  if (!mid) return null;
  try {
    let t = mid.replace(/Z([A-D])/g, (_m, c: string) => ESC[c]!).replace(/=+$/, '');
    t += '='.repeat((4 - (t.length % 4)) % 4);
    const decoded = Buffer.from(t, 'base64').toString('utf8');
    const m = /IGMessageID:([\d:]+)$/.exec(decoded);
    if (m) return `ig:${m[1]}`;
  } catch {
    /* não é base64: usa como veio */
  }
  return mid;
}
