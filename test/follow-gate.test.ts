import { describe, expect, it } from 'vitest';
import { immediateFromStart, parsePayload, validateGraph, type FlowGraph } from '../src/flow/schema.js';
import { comment, dm, postback, setup, textOf } from './helpers.js';

const gateFlow: FlowGraph = {
  start: 'g',
  nodes: {
    g: {
      type: 'follow_gate',
      data: { text: 'Toque para liberar 👇', button: 'Quero receber', not_following_text: 'Siga o perfil e toque em Já sigo', retry_button: 'Já sigo' },
      next: 'ok',
    },
    ok: { type: 'message', data: { text: 'Aqui está o material!', buttons: [{ label: 'Abrir', url: 'https://seusite.com.br' }] } },
  },
};

const firstPostback = (m: { kind: string; buttons?: { type: string; payload?: string }[] }) =>
  m.kind === 'buttons' ? (m.buttons!.find((b) => b.type === 'postback')?.payload ?? '') : '';

describe('bloco Só seguidores', () => {
  it('comentário: pede o clique; não segue → pede para seguir; seguiu e tocou → entrega', async () => {
    const t = setup();
    const { flowId } = t.addFlow(gateFlow);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });

    await t.engine.handleEvent(comment('CANVA'));
    expect(t.ig.sent).toHaveLength(1);
    expect(textOf(t.ig.sent[0]!.msg)).toBe('Toque para liberar 👇');
    const gate = firstPostback(t.ig.sent[0]!.msg as never);
    expect(parsePayload(gate)).toMatchObject({ type: 'gate', nodeId: 'g' });

    await t.engine.handleEvent(postback(gate, 'user-1', 'Quero receber'));
    const notYet = t.ig.sent[1]!.msg;
    expect(textOf(notYet)).toBe('Siga o perfil e toque em Já sigo');
    expect(notYet.kind === 'buttons' && notYet.buttons.map((b) => b.title)).toEqual(['Já sigo', 'Abrir perfil']);

    t.ig.followers.add('user-1');
    await t.engine.handleEvent(postback(firstPostback(notYet as never), 'user-1', 'Já sigo'));
    expect(textOf(t.ig.sent[2]!.msg)).toBe('Aqui está o material!');
  });

  it('quem já segue e tocou recebe direto; DM (já interagiu) confere sem pedir clique', async () => {
    const t = setup();
    const { flowId } = t.addFlow(gateFlow);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['material'] });
    t.ig.followers.add('user-7');
    await t.engine.handleEvent(dm('quero o material', 'user-7'));
    expect(t.ig.sent.map((s) => textOf(s.msg))).toEqual(['Aqui está o material!']);
  });

  it('se a Meta não responder mesmo depois do clique, não prende o cliente: entrega e registra', async () => {
    const t = setup();
    const { flowId } = t.addFlow(gateFlow);
    t.addTrigger(flowId, 'comment', { keywords: [], match: 'contains', public_replies: [], once_per_contact: false });
    await t.engine.handleEvent(comment('oi'));
    t.ig.followError = true;
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-1', 'Quero receber'));
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Aqui está o material!');
    expect(t.store.events.some((e: { type: string }) => e.type === 'follow_check_failed')).toBe(true);
  });
});

describe('avisos de fluxo que trava', () => {
  // O fluxo do print: mensagem com botão solto + condição "segue" logo em seguida, "Senão" vazio
  const stuck: FlowGraph = {
    start: 'm',
    nodes: {
      m: { type: 'message', data: { text: 'Obrigado por comentar', buttons: [{ label: 'CLIQUE AQUI', next: null }] }, next: 'c' },
      c: { type: 'condition', data: { rules: [{ when: { type: 'is_follower' }, next: null }], else: null } },
    },
  };

  it('aponta botão solto, caminhos vazios e checagem de seguidor antes do clique', () => {
    const msgs = validateGraph(stuck).issues.map((i) => `${i.node}: ${i.message}`);
    expect(msgs.some((m) => m.startsWith('m: Botão "CLIQUE AQUI" não está ligado'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('c: O caminho "Se…"'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('c: O caminho "Senão"'))).toBe(true);
    expect(msgs.some((m) => m.includes('Só seguidores'))).toBe(true);
    expect(immediateFromStart(stuck)).toEqual(['m', 'c']);
  });

  it('condição de seguidor ligada no botão (depois do clique) não gera o aviso', () => {
    const ok: FlowGraph = {
      start: 'm',
      nodes: {
        m: { type: 'message', data: { text: 'Toque abaixo', buttons: [{ label: 'Quero', next: 'c' }] } },
        c: { type: 'condition', data: { rules: [{ when: { type: 'is_follower' }, next: 'a' }], else: 'b' } },
        a: { type: 'message', data: { text: 'ok' } },
        b: { type: 'message', data: { text: 'siga' } },
      },
    };
    expect(validateGraph(ok).issues).toEqual([]);
  });
});
