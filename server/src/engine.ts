import { toolProgress } from './tools/progress';
import type { EngineModel, ModelSelection } from './models';
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
export type QuestionOption = { label: string; description: string };
/** One question the agent asks the user, with the choices it offers. */
export type Question = {
  id: string;
  /** Short label for the question; may be empty. */
  header: string;
  text: string;
  options: QuestionOption[];
  /** True when a written answer («Otra») is accepted besides the options. */
  other: boolean;
  /** The answer must not be shown back in the conversation. */
  secret: boolean;
};
/** Why a question stopped waiting without an answer. */
export type QuestionEnd = "paused" | "finished" | "stopped" | "closed";
export type EngineEvent =
  | { type: "availability"; available: boolean; exhausted?: boolean; safety: ExecutionSafety }
  | { type: "question"; conversationId: string; id: string; questions: Question[] }
  /** Questions of one conversation that stopped waiting together, in the order they were asked. */
  | { type: "questionClosed"; conversationId: string; ids: string[]; reason: Exclude<QuestionEnd, "closed"> }
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
  | { type: "detail"; conversationId?: string; text: string; key?: string }
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
  /** The models the account offers, without hidden ones. Asking costs no quota. */
  models(): Promise<EngineModel[]>;
  createWork(model?: ModelSelection, notes?: string): Promise<{ conversationId: string; title?: string }>;
  resumeWork(conversationId: string, model?: ModelSelection, notes?: string): Promise<void>;
  /**
   * Cheap name for a work whose last request already finished. Resolves with
   * undefined when the sample ran but produced no usable text; rejects when it
   * could not run at all (engine stopping, thread busy, request error), so the
   * work stays pending for the next finished request, even in a later session.
   */
  suggestTitle(conversationId: string): Promise<SuggestedTitle | undefined>;
  /** Stores the name in the engine so both sides show the same one. */
  renameWork(conversationId: string, title: string): Promise<void>;
  send(
    conversationId: string,
    text: string,
    files?: EngineFile[],
    context?: { filesReverted?: boolean; model?: ModelSelection },
  ): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  /**
   * Answers a question the agent is waiting on. Keys are question ids and each
   * value is what the agent receives for that question; an empty object tells
   * it the user did not answer. Rejects when the question is no longer waiting.
   */
  answer(conversationId: string, questionId: string, answers: Record<string, string[]>): Promise<void>;
  /**
   * Drops the memory of notices that were emitted but never delivered to a
   * work, so the next check says them again instead of treating them as said.
   */
  forgetDetails(keys: readonly string[]): void;
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
      "Bitácora no respondió y se reinició. Fijate si quedó algo a medias antes de volver a pedirlo.",
    other:
      "No pude completar el pedido. Podés ver el detalle y volver a intentarlo.",
  }[kind];
}

export function questionEndText(reason: QuestionEnd): string {
  const why = {
    paused: "Pausaste el trabajo",
    finished: "El pedido terminó",
    stopped: "Bitácora se detuvo",
    closed: "Bitácora se cerró",
  }[reason];
  return `${why} y esta pregunta quedó sin responder. Si querés, contestala en un mensaje nuevo.`;
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
