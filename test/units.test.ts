import { describe, expect, it } from 'vitest';
import { validateAnswer } from '../src/engine/engine.js';
import { parsePayload, payload, validateGraph } from '../src/flow/schema.js';
import { toGraphMessage } from '../src/instagram/client.js';
import { normalizeWebhook, verifySignature } from '../src/instagram/webhook.js';
import { isOpen } from '../src/lib/businessHours.js';
import { decrypt, encrypt, hmacSha256Hex, signState, verifyState } from '../src/lib/crypto.js';
import { renderTemplate } from '../src/lib/template.js';
import { matchKeyword, normalize } from '../src/lib/text.js';
import { loadTemplate } from './helpers.js';

describe('texto', () => {
  it('normaliza acentos e pontuação', () => expect(normalize('  Cardápio!!  Já? ')).toBe('cardapio ja'));
  it('palavras-chave com tolerância', () => {
    expect(matchKeyword('quero o cardapio', 'cardápio', 'contains')).toBe(true);
    expect(matchKeyword('quero o cardapo', 'cardapio', 'contains')).toBe(true); // erro de digitação
    expect(matchKeyword('oii', 'oi', 'exact')).toBe(false); // curtas exigem exato
    expect(matchKeyword('eu quero sim', 'eu quero', 'starts_with')).toBe(true);
    expect(matchKeyword('sim eu quero', 'eu quero', 'starts_with')).toBe(false);
    expect(matchKeyword('menu', 'menu', 'exact')).toBe(true);
  });
});

describe('template de variáveis', () => {
  it('substitui campos, vars e fallback', () => {
    const out = renderTemplate('Oi {{first_name|amigo}}, {{field.cidade}} {{var.x}}', {
      contact: { first_name: null },
      fields: { cidade: 'BH' },
      vars: { x: 1 },
    });
    expect(out).toBe('Oi amigo, BH 1');
  });
});

describe('horário de funcionamento', () => {
  const tz = 'America/Sao_Paulo';
  it('dentro e fora', () => {
    const h = { fri: [['18:00', '23:00']] as [string, string][] };
    expect(isOpen(h, tz, new Date('2026-11-06T22:00:00Z'))).toBe(true); // sex 19h
    expect(isOpen(h, tz, new Date('2026-11-06T13:00:00Z'))).toBe(false); // sex 10h
  });
  it('atravessa meia-noite', () => {
    const h = { sat: [['18:00', '02:00']] as [string, string][] };
    expect(isOpen(h, tz, new Date('2026-11-08T04:00:00Z'))).toBe(true); // dom 01h
    expect(isOpen(h, tz, new Date('2026-11-08T06:00:00Z'))).toBe(false); // dom 03h
  });
  it('sem configuração = aberto', () => expect(isOpen(undefined, tz)).toBe(true));
});

describe('validação de respostas', () => {
  it('telefone, email, número', () => {
    expect(validateAnswer('(31) 99999-8888', 'phone')).toBe('31999998888');
    expect(validateAnswer('123', 'phone')).toBeNull();
    expect(validateAnswer('A@B.com', 'email')).toBe('a@b.com');
    expect(validateAnswer('abc', 'email')).toBeNull();
    expect(validateAnswer('1.234,50', 'number')).toBe(1234.5);
    expect(validateAnswer('dois', 'number')).toBeNull();
  });
});

describe('crypto', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  it('criptografa e descriptografa', () => expect(decrypt(encrypt('segredo', key), key)).toBe('segredo'));
  it('state assinado', () => {
    const s = signState({ workspaceId: 'w' }, 'secret-secret-123');
    expect(verifyState<{ workspaceId: string }>(s, 'secret-secret-123')?.workspaceId).toBe('w');
    expect(verifyState(s, 'outro-segredo-xyz')).toBeNull();
    expect(verifyState(s.slice(0, -2) + 'xx', 'secret-secret-123')).toBeNull();
  });
});

describe('webhook', () => {
  it('assinatura', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${hmacSha256Hex('app-secret', body)}`;
    expect(verifySignature(body, sig, 'app-secret')).toBe(true);
    expect(verifySignature(body, sig, 'errado')).toBe(false);
    expect(verifySignature(body, undefined, 'app-secret')).toBe(false);
  });

  it('normaliza DM, postback, story, eco e comentário', () => {
    const events = normalizeWebhook({
      object: 'instagram',
      entry: [
        {
          id: '1784',
          time: 1700000000,
          messaging: [
            { sender: { id: 'u1' }, recipient: { id: '1784' }, timestamp: 1, message: { mid: 'm1', text: 'oi' } },
            { sender: { id: 'u1' }, recipient: { id: '1784' }, timestamp: 2, message: { mid: 'm2', text: 'Sim', quick_reply: { payload: 'P' } } },
            { sender: { id: 'u1' }, recipient: { id: '1784' }, timestamp: 3, postback: { mid: 'm3', title: 'Ver', payload: 'af:t:x' } },
            { sender: { id: 'u1' }, recipient: { id: '1784' }, timestamp: 4, message: { mid: 'm4', attachments: [{ type: 'story_mention', payload: { url: 'https://x' } }] } },
            { sender: { id: '1784' }, recipient: { id: 'u1' }, timestamp: 5, message: { mid: 'm5', text: 'eco', is_echo: true } },
          ],
          changes: [
            { field: 'comments', value: { id: 'c1', text: 'eu quero', from: { id: 'u2', username: 'ana' }, media: { id: 'md1', media_product_type: 'REELS' } } },
          ],
        },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual(['dm', 'dm', 'postback', 'story_mention', 'echo', 'comment']);
    expect(events[1]).toMatchObject({ quickReplyPayload: 'P' });
    expect(events[5]).toMatchObject({ commentId: 'c1', mediaId: 'md1', fromId: 'u2' });
  });
});

describe('schema do fluxo', () => {
  it('template de restaurante é válido', () => {
    const { graph, issues } = validateGraph(loadTemplate().flow);
    expect(graph).toBeDefined();
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });
  it('detecta destino inexistente e nó solto', () => {
    const { issues } = validateGraph({
      start: 'a',
      nodes: { a: { type: 'message', data: { text: 'x' }, next: 'zz' }, b: { type: 'end' } },
    });
    expect(issues.some((i) => i.level === 'error' && i.message.includes('zz'))).toBe(true);
    expect(issues.some((i) => i.level === 'warning' && i.node === 'b')).toBe(true);
  });
  it('payloads ida e volta', () => {
    expect(parsePayload(payload.button('v1', 'n1', 2))).toEqual({ type: 'button', versionId: 'v1', nodeId: 'n1', index: 2 });
    expect(parsePayload(payload.trigger('t1'))).toEqual({ type: 'trigger', triggerId: 't1' });
    expect(parsePayload('MEU_PAYLOAD')).toEqual({ type: 'custom', payload: 'MEU_PAYLOAD' });
  });
});

describe('formato Graph API', () => {
  it('botões e quick replies', () => {
    expect(
      toGraphMessage({ kind: 'buttons', text: 't', buttons: [{ type: 'postback', title: 'A', payload: 'p' }] }),
    ).toEqual({
      attachment: { type: 'template', payload: { template_type: 'button', text: 't', buttons: [{ type: 'postback', title: 'A', payload: 'p' }] } },
    });
    expect(toGraphMessage({ kind: 'text', text: 't', quickReplies: [{ title: 'A', payload: 'p' }] })).toEqual({
      text: 't',
      quick_replies: [{ content_type: 'text', title: 'A', payload: 'p' }],
    });
  });
});

describe('mid da Meta', () => {
  it('reconhece a mesma mensagem com codificações diferentes (envio x eco)', async () => {
    const { normalizeMid } = await import('../src/lib/mid.js');
    // IDs reais: o envio respondeu com o 1º, o eco do webhook chegou com o 2º
    const sent = 'bmV3X2lnX2RtX2l0ZAW06MTpJR01lc3NhZA2VJRDoxNzg0MTQyMTYxMTI1NDMwMTozNDAyODIzNjY4NDE3MTAzMDEyNDQyNTk1NjQ4MzUzMjk1MDI3MDU6MzMwOTI5NjQ1MzI3OTU2NTkyNDQzMzE3MjM5MDQ3NzgyNDAZD';
    const echo = 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQxNDIxNjExMjU0MzAxOjM0MDI4MjM2Njg0MTcxMDMwMTI0NDI1OTU2NDgzNTMyOTUwMjcwNTozMzA5Mjk2NDUzMjc5NTY1OTI0NDMzMTcyMzkwNDc3ODI0MAZDZD';
    expect(normalizeMid(sent)).toBe(normalizeMid(echo));
    expect(normalizeMid(sent)).toMatch(/^ig:17841421611254301:/);
    expect(normalizeMid('m_123')).toBe('m_123');
    expect(normalizeMid(null)).toBeNull();
  });
});
