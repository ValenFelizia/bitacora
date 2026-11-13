import type { Account } from './engine';
export type Message = { id: string; role: 'user' | 'assistant'; text: string };
export type Work = { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; details: string; busy: boolean; progress: string; problem?: string };
export type Snapshot = { account: Account; works: Work[] };
export type ClientCommand = { type: 'connect' } | { type: 'send'; workId?: string; text: string } | { type: 'interrupt'; workId: string };
export type ServerMessage = { type: 'snapshot'; state: Snapshot } | { type: 'selected'; workId: string } | { type: 'login'; url: string } | { type: 'problem'; text: string; detail?: string };
