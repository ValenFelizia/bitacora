export type Account = { connected: boolean; email?: string };
export type EngineEvent =
  | { type: 'account'; account: Account }
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'progress'; conversationId: string; text: string }
  | { type: 'message'; conversationId: string; id: string; text: string; delta: boolean }
  | { type: 'detail'; conversationId: string; text: string }
  | { type: 'finished'; conversationId: string; status: 'completed' | 'interrupted' | 'failed' }
  | { type: 'problem'; conversationId?: string; kind: 'limit' | 'disconnected' | 'temporary' | 'other'; detail: string };

export interface Engine {
  start(): Promise<void>;
  connectAccount(): Promise<{ url: string }>;
  account(): Promise<Account>;
  createWork(): Promise<{ conversationId: string; title?: string }>;
  resumeWork(conversationId: string): Promise<void>;
  send(conversationId: string, text: string): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  close(): Promise<void>;
}

export class EngineFailure extends Error {
  constructor(public kind: Extract<EngineEvent, { type: 'problem' }>['kind'], detail: string) { super(detail); }
}

export function problemText(kind: Extract<EngineEvent, { type: 'problem' }>['kind']): string {
  return { limit: 'Llegaste al límite de tu plan. Podés continuar cuando se renueve.', disconnected: 'Tu cuenta de ChatGPT está desconectada. Conectala para continuar.', temporary: 'ChatGPT está recibiendo muchos pedidos. Probá de nuevo en un momento.', other: 'No pude completar el pedido. Podés ver el detalle y volver a intentarlo.' }[kind];
}
