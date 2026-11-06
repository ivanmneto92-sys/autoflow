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
    expect(msgs.some((m) => m.includes('Só para seguidores'))).toBe(true);
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

describe('botão 🔒 Só para seguidores (direto na mensagem)', () => {
  // Exatamente o fluxo do Ivan: comentou CANVA → 1 mensagem com o conteúdo e o botão
  const canva: FlowGraph = {
    start: 'm',
    nodes: {
      m: {
        type: 'message',
        data: {
          text: 'Obrigado por comentar! Seu material está aqui 👇',
          buttons: [{ label: 'Receber material', url: 'https://canva.com/guia', followers_only: true }],
        },
      },
    },
  };

  it('quem não segue recebe o aviso; depois de seguir, "Já sigo" libera o link', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: ['Te chamei no direct!'], once_per_contact: false });

    await t.engine.handleEvent(comment('CANVA'));
    expect(t.ig.publicReplies).toHaveLength(1);
    const first = t.ig.sent[0]!.msg;
    expect(textOf(first)).toBe('Obrigado por comentar! Seu material está aqui 👇');
    // O link não vai aberto: vira um botão que confere antes
    expect(first.kind === 'buttons' && first.buttons[0]).toMatchObject({ type: 'postback', title: 'Receber material' });
    expect(parsePayload(firstPostback(first as never))).toMatchObject({ type: 'lock', nodeId: 'm', index: 0 });

    await t.engine.handleEvent(postback(firstPostback(first as never), 'user-1', 'Receber material'));
    const locked = t.ig.sent[1]!.msg;
    expect(textOf(locked)).toContain('exclusivo para quem me segue');
    expect(locked.kind === 'buttons' && locked.buttons.map((b) => b.title)).toEqual(['Já sigo', 'Abrir perfil']);

    t.ig.followers.add('user-1');
    await t.engine.handleEvent(postback(firstPostback(locked as never), 'user-1', 'Já sigo'));
    const open = t.ig.sent[2]!.msg;
    expect(textOf(open)).toContain('obrigado por me seguir');
    expect(open.kind === 'buttons' && open.buttons[0]).toMatchObject({ type: 'web_url', title: 'Receber material', url: 'https://canva.com/guia' });
  });

  it('quem já segue toca e recebe o link na hora', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });
    t.ig.followers.add('user-2');
    await t.engine.handleEvent(comment('canva', 'user-2'));
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-2', 'Receber material'));
    expect(t.ig.sent).toHaveLength(2);
    expect(t.ig.sent[1]!.msg.kind === 'buttons' && t.ig.sent[1]!.msg.buttons[0]!.type).toBe('web_url');
  });

  it('botão 🔒 que continua o fluxo: só segue para quem segue', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'm',
      nodes: {
        m: { type: 'message', data: { text: 'Quer o cupom?', buttons: [{ label: 'Quero', next: 'c', followers_only: true }] } },
        c: { type: 'message', data: { text: 'Cupom: SEGUIDOR10' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['cupom'] });
    await t.engine.handleEvent(dm('cupom', 'user-3'));
    const pb = firstPostback(t.ig.sent[0]!.msg as never);
    await t.engine.handleEvent(postback(pb, 'user-3', 'Quero'));
    expect(textOf(t.ig.sent[1]!.msg)).toContain('exclusivo');
    t.ig.followers.add('user-3');
    await t.engine.handleEvent(postback(pb, 'user-3', 'Quero'));
    expect(textOf(t.ig.sent[2]!.msg)).toBe('Cupom: SEGUIDOR10');
  });
});

describe('mensagem: salvar a opção tocada num campo', () => {
  it('guarda o texto da resposta rápida sem precisar de nó de Ação', async () => {
    const t = setup();
    const { flowId } = t.addFlow({
      start: 'm',
      nodes: {
        m: { type: 'message', data: { text: 'Qual área?', save_to: 'area', quick_replies: [{ label: 'Trabalhista', next: 'f' }, { label: 'Família', next: 'f' }] } },
        f: { type: 'message', data: { text: 'Área: {{field.area}}' } },
      },
    });
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['oi'] });
    await t.engine.handleEvent(dm('oi'));
    const m = t.ig.sent[0]!.msg;
    const qrPayload = m.kind === 'text' ? m.quickReplies![1]!.payload : '';
    await t.engine.handleEvent(dm('Família', 'user-1', qrPayload));
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Área: Família');
  });
});

describe('🔒 sem passo redundante para quem já segue', () => {
  const canva: FlowGraph = {
    start: 'm',
    nodes: { m: { type: 'message', data: { text: 'Seu material 👇', buttons: [{ label: 'CLIQUE AQUI', url: 'https://site.com/guia', followers_only: true }] } } },
  };
  const urlOf = (m: { kind: string; buttons?: { type: string; url?: string }[] }) => (m.kind === 'buttons' ? m.buttons![0] : undefined);

  it('quem já seguia: 1º toque recebe só "Aqui está 👇" + link; da 2ª vez em diante o botão já abre direto', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });
    t.ig.followers.add('user-1');

    // 1ª vez (só comentou: a Meta não deixa conferir antes do toque)
    await t.engine.handleEvent(comment('canva'));
    expect(urlOf(t.ig.sent[0]!.msg as never)).toMatchObject({ type: 'postback' });
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-1', 'CLIQUE AQUI'));
    expect(textOf(t.ig.sent[1]!.msg)).toBe('Aqui está 👇');

    // Comenta em outro post depois: já sabemos que segue → link direto no 1º toque
    await t.engine.handleEvent(comment('canva', 'user-1', 'media-2'));
    expect(urlOf(t.ig.sent[2]!.msg as never)).toMatchObject({ type: 'web_url', url: 'https://site.com/guia' });
  });

  it('quem acabou de seguir ("Já sigo") recebe o agradecimento', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });
    await t.engine.handleEvent(comment('canva'));
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-1', 'CLIQUE AQUI'));
    t.ig.followers.add('user-1');
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[1]!.msg as never), 'user-1', 'Já sigo'));
    expect(textOf(t.ig.sent[2]!.msg)).toContain('obrigado por me seguir');
  });

  it('quem já conversou com a conta (DM) e segue recebe o link direto', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'dm_keyword', { keywords: ['canva'] });
    t.ig.followers.add('user-5');
    await t.engine.handleEvent(dm('canva', 'user-5'));
    expect(urlOf(t.ig.sent[0]!.msg as never)).toMatchObject({ type: 'web_url' });
  });
});

describe('🔒 quando a Meta exige que a pessoa ENVIE uma mensagem antes de conferir', () => {
  const canva: FlowGraph = {
    start: 'm',
    nodes: { m: { type: 'message', data: { text: 'Seu material 👇', buttons: [{ label: 'CLIQUE AQUI', url: 'https://site.com/guia', followers_only: true }] } } },
  };

  it('pede um 👍 (resposta rápida conta como mensagem) e confere de novo', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });
    await t.engine.handleEvent(comment('canva'));
    t.ig.followError = true; // "User consent is required to access user profile"
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-1', 'CLIQUE AQUI'));
    const ask = t.ig.sent[1]!.msg;
    expect(textOf(ask)).toContain('Toque em 👍');
    const qr = ask.kind === 'text' ? ask.quickReplies![0]! : null;
    expect(qr!.title).toBe('👍 Liberar');
    expect(parsePayload(qr!.payload)).toMatchObject({ type: 'lock', consent: true });

    // Tocou no 👍 (chega como mensagem): agora a Meta responde
    t.ig.followError = false;
    t.ig.followers.add('user-1');
    await t.engine.handleEvent(dm('👍 Liberar', 'user-1', qr!.payload));
    expect(textOf(t.ig.sent[2]!.msg)).toBe('Aqui está 👇');
  });

  it('se mesmo depois do 👍 a Meta não responder, não prende o cliente: entrega e registra', async () => {
    const t = setup();
    const { flowId } = t.addFlow(canva);
    t.addTrigger(flowId, 'comment', { keywords: ['canva'], match: 'contains', public_replies: [], once_per_contact: false });
    await t.engine.handleEvent(comment('canva'));
    t.ig.followError = true;
    await t.engine.handleEvent(postback(firstPostback(t.ig.sent[0]!.msg as never), 'user-1', 'CLIQUE AQUI'));
    const ask = t.ig.sent[1]!.msg;
    await t.engine.handleEvent(dm('👍 Liberar', 'user-1', ask.kind === 'text' ? ask.quickReplies![0]!.payload : ''));
    expect(t.ig.sent).toHaveLength(3);
    expect(t.ig.sent[2]!.msg.kind).toBe('buttons');
    expect(t.store.events.filter((e: { type: string }) => e.type === 'follow_check_failed')).toHaveLength(2);
  });
});
