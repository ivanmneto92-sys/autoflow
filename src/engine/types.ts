import type { IgClient } from '../instagram/client.js';
import type { PaymentGateway } from '../payments/gateway.js';
import type { Store } from '../store/types.js';

export type ScheduledJob =
  | { kind: 'resume_delay'; sessionId: string; waitToken: string; nodeId: string | null }
  | { kind: 'ask_timeout'; sessionId: string; waitToken: string }
  /** Lembrete único de uma Pergunta sem resposta */
  | { kind: 'ask_reminder'; sessionId: string; waitToken: string }
  | { kind: 'resume_quota'; sessionId: string; waitToken: string; nodeId: string }
  /** O Pix mudou de status (webhook do provedor ou consulta periódica) */
  | { kind: 'payment_update'; sessionId: string; paymentId: string };

export interface Scheduler {
  schedule(job: ScheduledJob, delayMs: number): Promise<void>;
}

export interface EngineLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface EngineDeps {
  store: Store;
  ig: IgClient;
  scheduler: Scheduler;
  /** Retorna true se a conta ainda tem cota de envio nesta hora. */
  consumeQuota: (accountId: string, limit: number) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Cobrança por Pix (nó "Cobrar Pix"). Sem isso o nó avisa que não há pagamento configurado. */
  payments?: PaymentGateway;
  now?: () => Date;
  log?: EngineLogger;
  /** Endereço público da API: botões de link viram <linkBase>/r/<code> para contar cliques. Sem isso, links vão direto. */
  linkBase?: string;
  /** Espera antes de concluir que um eco é de humano (o robô pode ainda estar gravando a mensagem que acabou de enviar). */
  echoGraceMs?: number;
}

export const MAX_STEPS = 50;
/** Margem de segurança para a janela de 24h */
export const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
