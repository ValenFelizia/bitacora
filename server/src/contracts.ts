import type { Account } from "./engine";
export type Message = { id: string; role: "user" | "assistant"; text: string };
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
  engine: { available: boolean; exhausted?: boolean; safety: { allowed: boolean; detail: string } };
  notice?: string;
};
export type ClientCommand =
  | { type: "connect" }
  | { type: "retry" }
  | { type: "send"; workId?: string; text: string }
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
