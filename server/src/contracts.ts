import type { Account, ExecutionSafety, Question } from "./engine";
import type { ModelState } from "./models";
export type { Question, QuestionOption } from "./engine";
export type { ModelChoice, ModelState } from "./models";
/** Narrowest and widest the deliverables panel can be dragged to, in CSS pixels. */
export const PANEL_WIDTH = { min: 280, max: 640, default: 300 } as const;
export type Upload = { name: string; data: string };
export type FileRef = { id: string; path: string; name: string; mime: string; createdAt: string; reverted?: boolean };
export type Message = { id: string; role: "user" | "assistant"; text: string; attachments?: FileRef[]; results?: FileRef[] };
/** Questions the agent asked in a work, waiting for the user or no longer answerable. */
export type PendingQuestion = {
  id: string;
  askedAt: string;
  questions: Question[];
  /** Set when it can no longer be answered: why, in plain words. */
  closed?: string;
};
export type Work = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  details: string;
  busy: boolean;
  progress: string;
  problem?: string;
  question?: PendingQuestion;
};
export type Snapshot = {
  hasBrand?: boolean;
  account: Account;
  works: Work[];
  engine: { available: boolean; starting?: boolean; exhausted?: boolean; safety: ExecutionSafety };
  notice?: string;
  fileToken?: string;
  undo?: import("./backups").UndoTarget;
  fileRevision?: number;
  /** The model the next request uses, for every work (DEC-014). */
  model?: ModelState;
  /** Width the user dragged the deliverables panel to, remembered between sessions. */
  panelWidth?: number;
};
export type ClientCommand =
  | { type: "undo"; id: string }
  | { type: "discardUndo"; id: string }
  | { type: "connect" }
  | { type: "retry" }
  | { type: "prepareProtection" }
  | { type: "send"; workId?: string; text: string; attachments?: Upload[] }
  | { type: "rename"; workId: string; title: string }
  | { type: "interrupt"; workId: string }
  /** One answer per question id: the label of the chosen option or the written text. */
  | { type: "answer"; workId: string; questionId: string; answers: Record<string, string> }
  /** «Ahora no»: the agent goes on without an answer. */
  | { type: "skipQuestion"; workId: string; questionId: string }
  | { type: "chooseModel"; model: string }
  /** The model menu opened: list again if there is no fresh list. */
  | { type: "refreshModels" }
  | { type: "panelWidth"; width: number };
export type ServerMessage =
  | { type: "snapshot"; state: Snapshot }
  | {
      type: "message";
      workId: string;
      id: string;
      text: string;
      delta: boolean;
    }
  | { type: "selected"; workId: string }
  | { type: "login"; url: string }
  /** `workId` names the work the problem is about, so the screen can take the user there. */
  | { type: "problem"; text: string; detail?: string; workId?: string };
