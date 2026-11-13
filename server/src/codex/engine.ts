import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import type { Engine, EngineEvent, Account } from '../engine';
import { EngineFailure } from '../engine';
import type { ClientRequest } from './generated/ClientRequest';
import type { ServerNotification } from './generated/ServerNotification';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse';
import type { LoginAccountResponse } from './generated/v2/LoginAccountResponse';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';

type Responses = { initialize: unknown; 'account/read': GetAccountResponse; 'account/login/start': LoginAccountResponse; 'account/login/cancel': unknown; 'thread/start': ThreadStartResponse; 'thread/resume': ThreadResumeResponse; 'turn/start': TurnStartResponse; 'turn/interrupt': unknown };
export function classifyProblem(error: unknown): Extract<EngineEvent, { type: 'problem' }>['kind'] {
  const text = JSON.stringify(error);
  if (/usageLimitExceeded|sessionBudgetExceeded/.test(text)) return 'limit';
  if (/unauthorized|not authenticated|not logged in|401/i.test(text)) return 'disconnected';
  if (/rateLimitExceeded|serverOverloaded/.test(text)) return 'temporary';
  return 'other';
}

export class CodexEngine implements Engine {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private turns = new Map<string, string>();
  private loginId?: string;
  private stopping = false;
  private stderr = '';
  constructor(private options: { home: string; workspace: string; binary?: string }) {}
  subscribe(listener: (event: EngineEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: EngineEvent) { for (const listener of this.listeners) listener(event); }
  async start() {
    await mkdir(this.options.home, { recursive: true });
    await mkdir(this.options.workspace, { recursive: true });
    const binary = this.options.binary || 'codex';
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.options.home };
    // Never inherit API credentials as a fallback for the subscription login.
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8', windowsHide: true }).trim();
    if (version !== 'codex-cli 0.168.0') throw new Error(`Expected codex-cli 0.168.0, received ${version}`);
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], { cwd: this.options.workspace, env, windowsHide: true, stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.fail(new Error(`Invalid engine message: ${String(error)}`)); }
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-16000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => { this.fail(new Error(`Codex process stopped. ${this.stderr}`)); this.child = undefined; });
    await this.rpc('initialize', { clientInfo: { name: 'bitacora', title: 'Bitácora', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    this.write({ method: 'initialized' });
  }
  private write(value: unknown) { if (!this.child || this.child.stdin.destroyed) throw new Error('Engine unavailable'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private rpc<M extends keyof Responses>(method: M, params: Extract<ClientRequest, { method: M }>['params']): Promise<Responses[M]> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Engine request timed out: ${method}. Do not automatically retry.`)); }, 45000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.stopping) {
      for (const conversationId of this.turns.keys()) { this.emit({ type: 'problem', conversationId, kind: 'other', detail: error.message }); this.emit({ type: 'finished', conversationId, status: 'failed' }); }
      this.turns.clear();
      this.emit({ type: 'problem', kind: 'other', detail: error.message });
    }
  }
  private receive(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new EngineFailure(classifyProblem(message.error), JSON.stringify(message.error))); else pending.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // Interactive tools are outside this issue. Reject explicitly; never leave Codex waiting.
      this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by Bitacora.' } });
    } else if (message.method) this.notification(message as ServerNotification);
  }
  private notification(n: ServerNotification) {
    switch (n.method) {
      case 'account/updated': case 'account/login/completed':
        if (n.method === 'account/login/completed') {
          this.loginId = undefined;
          if (!n.params.success) this.emit({ type: 'problem', kind: 'disconnected', detail: n.params.error || 'Login cancelled' });
        }
        void this.account().then(account => this.emit({ type: 'account', account })).catch(error => this.emit({ type: 'problem', kind: 'other', detail: String(error) })); break;
      case 'thread/name/updated':
        if (n.params.threadName) this.emit({ type: 'title', conversationId: n.params.threadId, title: n.params.threadName }); break;
      case 'turn/started':
        this.turns.set(n.params.threadId, n.params.turn.id);
        this.emit({ type: 'progress', conversationId: n.params.threadId, text: 'Preparando la respuesta…' }); break;
      case 'item/agentMessage/delta':
        this.emit({ type: 'message', conversationId: n.params.threadId, id: n.params.itemId, text: n.params.delta, delta: true }); break;
      case 'item/started': case 'item/completed': {
        const { threadId: conversationId, item } = n.params;
        if (item.type === 'agentMessage') {
          if (n.method === 'item/completed') this.emit({ type: 'message', conversationId, id: item.id, text: item.text, delta: false });
        } else if (item.type !== 'userMessage') {
          const text = item.type === 'commandExecution' ? 'Leyendo los archivos…' : item.type === 'fileChange' ? 'Actualizando los archivos…' : item.type === 'webSearch' || item.type === 'mcpToolCall' ? 'Buscando información…' : 'Preparando la respuesta…';
          this.emit({ type: 'progress', conversationId, text });
          this.emit({ type: 'detail', conversationId, text: JSON.stringify(item) });
        }
        break;
      }
      case 'item/commandExecution/outputDelta': case 'item/fileChange/outputDelta':
        this.emit({ type: 'detail', conversationId: n.params.threadId, text: n.params.delta }); break;
      case 'error':
        this.emit({ type: 'problem', conversationId: n.params.threadId, kind: classifyProblem(n.params.error), detail: JSON.stringify(n.params.error) }); break;
      case 'turn/completed': {
        const { threadId: conversationId, turn } = n.params;
        this.turns.delete(conversationId);
        if (turn.error) this.emit({ type: 'problem', conversationId, kind: classifyProblem(turn.error), detail: JSON.stringify(turn.error) });
        this.emit({ type: 'finished', conversationId, status: turn.status === 'inProgress' ? 'failed' : turn.status }); break;
      }
    }
  }
  async account(): Promise<Account> {
    const { account } = await this.rpc('account/read', { refreshToken: false });
    return account?.type === 'chatgpt' ? { connected: true, email: account.email || undefined } : { connected: false };
  }
  async connectAccount() {
    if (this.loginId) await this.rpc('account/login/cancel', { loginId: this.loginId });
    const login = await this.rpc('account/login/start', { type: 'chatgpt' });
    if (login.type !== 'chatgpt') throw new Error('Expected ChatGPT login');
    this.loginId = login.loginId; return { url: login.authUrl };
  }
  private settings() { return { cwd: this.options.workspace, approvalPolicy: 'never' as const, sandbox: 'workspace-write' as const, developerInstructions: 'Respondé en castellano rioplatense, simple y sin términos técnicos. Trabajá en la carpeta actual. No generes imágenes con IA.' }; }
  async createWork() {
    const { thread } = await this.rpc('thread/start', this.settings());
    return { conversationId: thread.id, title: thread.name || undefined };
  }
  async resumeWork(conversationId: string) { await this.rpc('thread/resume', { threadId: conversationId, ...this.settings() }); }
  async send(conversationId: string, text: string) {
    const { turn } = await this.rpc('turn/start', { threadId: conversationId, input: [{ type: 'text', text, text_elements: [] }], cwd: this.options.workspace, approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.options.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
    if (turn.status === 'inProgress') this.turns.set(conversationId, turn.id);
  }
  async interrupt(conversationId: string) { const turnId = this.turns.get(conversationId); if (turnId) await this.rpc('turn/interrupt', { threadId: conversationId, turnId }); }
  async close() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
