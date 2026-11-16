import { toolProgress } from './tools/progress';
export type Account = { connected: boolean; email?: string };
export type ExecutionSafety = {
  allowed: boolean;
  detail: string;
  status?: "needed" | "preparing" | "ready" | "failed";
  needsPermission?: boolean;
  issue?: "check" | "setup" | "uncertain" | "interrupted" | "restart" | "readBlock";
  /**
   * False when this computer cannot stop the agent from reading files outside
   * the folder: work is allowed with the previous write protection and the app
   * says so. True when the read block is in place. Undefined while unknown.
   */
  readBlock?: boolean;
};
export type Activity =
  | keyof typeof toolProgress
  | "preparing"
  | "reading"
  | "executing"
  | "writing"
  | "tool"
  | "responding"
  | "retrying";
export type EngineEvent =
  | { type: "availability"; available: boolean; exhausted?: boolean; safety: ExecutionSafety }
  | { type: "protection"; safety: ExecutionSafety }
  | { type: "account"; account: Account }
  | { type: "title"; conversationId: string; title: string }
  | { type: "progress"; conversationId: string; activity: Activity }
  | { type: "checkpoint"; conversationId: string }
  | {
      type: "message";
      conversationId: string;
      id: string;
      text: string;
      delta: boolean;
    }
  | { type: "detail"; conversationId: string; text: string }
  | {
      type: "finished";
      conversationId: string;
      status: "completed" | "interrupted" | "failed";
    }
  | {
      type: "problem";
      conversationId?: string;
      kind: "limit" | "disconnected" | "temporary" | "unresponsive" | "other";
      detail: string;
    };

export type EngineFile = { path: string; mime: string };

/** Short name for a work, with what the extra request cost when the engine reports it. */
export type SuggestedTitle = {
  title: string;
  usage?: { input: number; cached: number; output: number };
};

export interface Engine {
  start(): Promise<void>;
  retry(): Promise<void>;
  executionSafety(): ExecutionSafety;
  prepareProtection(): Promise<void>;
  connectAccount(): Promise<{ url: string }>;
  account(): Promise<Account>;
  createWork(): Promise<{ conversationId: string; title?: string }>;
  resumeWork(conversationId: string): Promise<void>;
  /**
   * Cheap name for a work whose last request already finished, or undefined
   * when the engine cannot suggest one. Never starts a visible request.
   */
  suggestTitle(conversationId: string): Promise<SuggestedTitle | undefined>;
  /** Stores the name in the engine so both sides show the same one. */
  renameWork(conversationId: string, title: string): Promise<void>;
  send(conversationId: string, text: string, files?: EngineFile[], context?: { filesReverted?: boolean }): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  close(): Promise<void>;
}

export class EngineFailure extends Error {
  constructor(
    public kind: Extract<EngineEvent, { type: "problem" }>["kind"],
    detail: string,
  ) {
    super(detail);
  }
}

export function problemText(
  kind: Extract<EngineEvent, { type: "problem" }>["kind"],
): string {
  return {
    limit: "Llegaste al límite de tu plan. Podés continuar cuando se renueve.",
    disconnected:
      "Tu cuenta de ChatGPT está desconectada. Conectala para continuar.",
    temporary:
      "ChatGPT está recibiendo muchos pedidos. Probá de nuevo en un momento.",
    unresponsive:
      "El motor no respondió y lo reinicié. Fijate si quedó algo a medias antes de volver a pedirlo.",
    other:
      "No pude completar el pedido. Podés ver el detalle y volver a intentarlo.",
  }[kind];
}

export const activityText: Record<Activity, string> = {
  ...toolProgress,
  preparing: "Preparando la respuesta…",
  reading: "Leyendo los archivos…",
  executing: "Trabajando en los archivos…",
  writing: "Actualizando los archivos…",
  tool: "Buscando información…",
  responding: "Escribiendo la respuesta…",
  retrying: "ChatGPT está reintentando el pedido…",
};
