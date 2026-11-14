import type { Account, ExecutionSafety } from "./engine";
export type Upload = { name: string; data: string };
export type FileRef = { id: string; path: string; name: string; mime: string; createdAt: string };
export type Message = { id: string; role: "user" | "assistant"; text: string; attachments?: FileRef[]; results?: FileRef[] };
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
};
export type Snapshot = {
  account: Account;
  works: Work[];
  engine: { available: boolean; exhausted?: boolean; safety: ExecutionSafety };
  notice?: string;
  fileToken?: string;
  undo?: import("./backups").UndoTarget;
  fileRevision?: number;
};
export type ClientCommand =
  | { type: "undo"; id: string }
  | { type: "connect" }
  | { type: "retry" }
  | { type: "prepareProtection" }
  | { type: "send"; workId?: string; text: string; attachments?: Upload[] }
  | { type: "interrupt"; workId: string };
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
