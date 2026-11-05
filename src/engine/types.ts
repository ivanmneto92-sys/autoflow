import type { IgClient } from '../instagram/client.js';
import type { Store } from '../store/types.js';

export type ScheduledJob =
  | { kind: 'resume_delay'; sessionId: string; waitToken: string; nodeId: string | null }
  | { kind: 'ask_timeout'; sessionId: string; waitToken: string }
  | { kind: 'resume_quota'; sessionId: string; waitToken: string; nodeId: string };

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
  now?: () => Date;
  log?: EngineLogger;
}

export const MAX_STEPS = 50;
/** Margem de segurança para a janela de 24h */
export const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
