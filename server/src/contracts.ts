import type { Account, ExecutionSafety, Question } from "./engine";
export type { Question, QuestionOption } from "./engine";
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
  | { type: "answer"; workId: string; questionId: string; answers: Record<string, string> };
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
  | { type: "problem"; text: string; detail?: string };
