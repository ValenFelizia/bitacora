import type { Account, ExecutionSafety, Question } from "./engine";
import type { ModelState } from "./models";
export type { Question, QuestionOption } from "./engine";
export type { ModelChoice, ModelState } from "./models";
/** Narrowest and widest the deliverables panel can be dragged to, in CSS pixels. */
export const PANEL_WIDTH = { min: 280, max: 640, default: 300 } as const;
export type Upload = { name: string; data: string };
export type FileRef = { id: string; path: string; name: string; mime: string; createdAt: string; reverted?: boolean; openedAt?: string };
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
  /** The person marked it as done: it waits folded under «Listos» (issue #88). */
  ready?: boolean;
};
export type Snapshot = {
  workspace?: string;
  hasBrand?: boolean;
  account: Account;
  works: Work[];
  engine: { available: boolean; starting?: boolean; updateReady?: boolean; exhausted?: boolean; safety: ExecutionSafety };
  notice?: string;
  undo?: import("./backups").UndoTarget;
  fileRevision?: number;
  /** The model the next request uses, for every work (DEC-014). */
  model?: ModelState;
  /** Width the user dragged the deliverables panel to, remembered between sessions. */
  panelWidth?: number;
  /**
   * The welcome questions (issue #67). `pending` shows them; any other value
   * means the server remembers they were answered or skipped.
   */
  welcome?: "pending" | "done" | "skipped";
  /** Uses marked in the welcome, which pick the suggested routes. */
  uses?: string[];
  /** True once after choosing a folder when Codex has unimported chats in that folder. */
  codexImportOffer?: boolean;
};
export type CodexChat = { id: string; title: string; date: string; folder: string; sameFolder: boolean; imported: boolean };
export type CodexImportMessage =
  | { type: "codexChats"; chats: CodexChat[] }
  | { type: "codexImported"; imported: string[]; failed: string[] }
  | { type: "codexImportProblem"; text: string };
export type ClientCommand =
  | { type: "chooseWorkspace"; path: string }
  | { type: "listCodexChats" }
  | { type: "cancelCodexChatList" }
  | { type: "importCodexChats"; ids: string[] }
  | { type: "dismissCodexImportOffer" }
  | { type: "undo"; id: string }
  | { type: "discardUndo"; id: string }
  | { type: "connect" }
  | { type: "retry" }
  | { type: "prepareProtection" }
  | { type: "send"; workId?: string; text: string; attachments?: Upload[] }
  | { type: "rename"; workId: string; title: string }
  /** Marks a work as ready or brings it back to the list (issue #88). */
  | { type: "setReady"; workId: string; ready: boolean }
  | { type: "interrupt"; workId: string }
  /** One answer per question id: the label of the chosen option or the written text. */
  | { type: "answer"; workId: string; questionId: string; answers: Record<string, string> }
  /** «Ahora no»: the agent goes on without an answer. */
  | { type: "skipQuestion"; workId: string; questionId: string }
  | { type: "chooseModel"; model: string }
  /** The model menu opened: list again if there is no fresh list. */
  | { type: "refreshModels" }
  | { type: "panelWidth"; width: number }
  /** Answers to the welcome questions: names first, then what she will use it for. */
  | { type: "welcome"; answers: { agency: string; person: string; uses: string[]; other?: string } }
  /** The welcome is closed without answers. */
  | { type: "skipWelcome" }
  /** Deliverable results opened, previewed, downloaded, or copied by the user. */
  | { type: "markOpened"; fileIds: string[] };
export type ServerMessage =
  | CodexImportMessage
  | { type: "snapshot"; state: Snapshot }
  | {
      type: "message";
      workId: string;
      id: string;
      text: string;
      delta: boolean;
    }
  | { type: "selected"; workId: string }
  | { type: "workspaceChoice"; problem?: string }
  | { type: "login"; url: string }
  /** `workId` names the work the problem is about, so the screen can take the user there. */
  | { type: "problem"; text: string; detail?: string; workId?: string };
