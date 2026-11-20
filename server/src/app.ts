import { existsSync } from "node:fs";
import { Backups, BACKUP_LIMITS, RestoreProblem, pathKey } from './backups';
import { mkdir, readFile, writeFile, rename, copyFile, rm } from "node:fs/promises";
import { WorkspaceFiles, MAX_RESULT, type FileScan } from "./workspace-files";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { rememberUserUrls } from './allowed-urls';
import { initializeKit } from './tools/kit';
import type { Account, Engine, EngineEvent, SuggestedTitle } from "./engine";
import { problemText, EngineFailure, activityText, questionEndText } from "./engine";
import { fallbackTitle, MAX_TITLE } from "./titles";
import { agentAnswer, answerRecord } from "./questions";
import type { FileRef, Message, Work, Snapshot, ClientCommand, ServerMessage, PendingQuestion } from "./contracts";
import { PANEL_WIDTH } from "./contracts";
import { isAllowedModel, resolveModel, type EngineModel } from "./models";
import { readWelcomeProfile, saveWelcomeProfile } from "./welcome-profile";
import { WelcomeProblem, profileNotes, welcomeAnswers, type WelcomeAnswers, type WelcomeUseId } from "./welcome";

/** Choices kept for the whole app in `settings.json`, not per work (DEC-014). */
type Settings = { model?: string; panelWidth?: number; welcome?: "done" | "skipped" };

type SavedWork = Work & { conversationId: string; titlePending?: boolean; renamedByUser?: boolean; pendingFiles?: { messageId: string; before?: Record<string, string> } };
const isText = (value: unknown) => typeof value === "string";
/** A model list older than this is asked again when the menu opens. */
const CATALOGUE_MAX_AGE_MS = 10 * 60_000;
/** How long close() lets a title request already in flight finish before stopping the engine. */
const TITLE_CLOSE_WAIT_MS = 400;
/**
 * What the app says when the single kit copy fails. Kept as one string so a
 * copy that works can tell whether the visible notice is still that failure.
 */
const KIT_NOT_READY =
  "No pude preparar la carpeta de tu agencia. Sin los archivos del kit no puedo empezar tus pedidos. Volvé a abrir Bitácora para intentarlo de nuevo.";
const isFileRef = (value: unknown) => {
  const file = value as Partial<FileRef> | null;
  return !!file && isText(file.id) && isText(file.path) && isText(file.name) && isText(file.mime) && isText(file.createdAt);
};
const isMessage = (value: unknown) => {
  const message = value as Partial<Message> | null;
  return !!message && isText(message.id) && (message.role === "user" || message.role === "assistant") && isText(message.text) &&
    (message.attachments === undefined || (Array.isArray(message.attachments) && message.attachments.every(isFileRef))) &&
    (message.results === undefined || (Array.isArray(message.results) && message.results.every(isFileRef)));
};
const isQuestion = (value: unknown) => {
  const question = value as Partial<PendingQuestion> | null;
  return !!question && isText(question.id) && isText(question.askedAt) &&
    (question.closed === undefined || isText(question.closed)) &&
    Array.isArray(question.questions) && question.questions.every((q) =>
      !!q && isText(q.id) && isText(q.header) && isText(q.text) && typeof q.other === "boolean" && typeof q.secret === "boolean" &&
      Array.isArray(q.options) && q.options.every((o) => !!o && isText(o.label) && isText(o.description)));
};
const WAITING_ANSWER = "Esperando tu respuesta…";
const isSavedWork = (value: unknown) => {
  const work = value as Partial<SavedWork> | null;
  return !!work && isText(work.id) && isText(work.conversationId) && isText(work.title) && isText(work.details) &&
    isText(work.createdAt) && isText(work.updatedAt) && isText(work.progress) &&
    (work.problem === undefined || isText(work.problem)) &&
    (work.question === undefined || isQuestion(work.question)) &&
    (work.busy === undefined || typeof work.busy === "boolean") &&
    (work.titlePending === undefined || typeof work.titlePending === "boolean") &&
    (work.renamedByUser === undefined || typeof work.renamedByUser === "boolean") &&
    Array.isArray(work.messages) && work.messages.every(isMessage) &&
    (work.pendingFiles === undefined || (!!work.pendingFiles && isText(work.pendingFiles.messageId)));
};
export class App {
  private backups?: Backups;
  private backupReceipt?: string;
  private fileRevision = 0;
  private scanning = new Set<string>();
  private scans = new Set<Promise<void>>();
  private notice?: string;
  /**
   * Set when the single kit copy fails. The rest of the kit is what gives the
   * agency its rules (`AGENTS.md`) and the example, so no request runs until
   * the copy works; it is retried on each start and on each request. Only the
   * skills refresh may fail softly (DEC-011).
   */
  private kitProblem?: string;
  private kitDetail?: string;
  /** The copy in flight, shared by every request that arrives meanwhile. */
  private kitPreparing?: Promise<boolean>;
  private available = false;
  private starting = true;
  private exhausted = false;
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private writeRevision = 0;
  private works: SavedWork[] = [];
  private accountState?: Account;
  private writes: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private submitting = false;
  private resumed = new Set<string>();
  // Work ids whose saved request has not reached the engine yet, and pauses
  // requested during that window: they are delivered once the turn starts.
  private unsent = new Set<string>();
  private pauseRequested = new Set<string>();
  // Works created in this session whose first request has not been titled yet,
  // and works the user named by hand: a chosen name is never replaced.
  private titlePending = new Set<string>();
  private renamed = new Set<string>();
  private titleTasks = new Set<Promise<void>>();
  /**
   * Notices that belong to no work yet. Each one keeps the key the engine uses
   * to avoid repeating itself, so a notice that is thrown away can make the
   * engine say it again.
   */
  private pendingDetails: { text: string; key?: string }[] = [];
  /**
   * Questions asked while another one is on screen, by work. Codex can ask
   * again before the first is answered and waits on each one: they are shown
   * one at a time, in order, like its own client does.
   */
  private queuedQuestions = new Map<string, PendingQuestion[]>();
  private settings: Settings = {};
  private settingsWrites: Promise<void> = Promise.resolve();
  /** Uses the welcome marked, which pick the suggested routes. */
  private uses: WelcomeUseId[] = [];
  /**
   * A welcome command is being saved. Set synchronously before any wait, so a
   * second one (a double click, two windows) does not pass the same check.
   */
  private welcomeSaving = false;
  /** The account's models; undefined until the engine answers. */
  private catalogue?: EngineModel[];
  private catalogueAt = 0;
  /** The list on hand was asked for another account. */
  private catalogueStale = false;
  private catalogueRequest = 0;
  private listing = false;
  constructor(
    private engine: Engine,
    private data: string,
    private publish: (message: ServerMessage) => void,
    private files = { rename, copyFile },
    private workspace?: WorkspaceFiles,
    private kitSource?: string,
  ) {}
  async start() {
    await this.initialize();
    await this.startEngine();
  }
  /**
   * Copies the kit into a new agency and refreshes its skills on every start.
   * Only the skills refresh may fail softly (a read-only or busy skill is a
   * notice). Without the rest of the kit the agency would have no `AGENTS.md`,
   * so a failed copy leaves `kitProblem` set and `command()` refuses requests
   * until a copy works.
   *
   * One copy at a time: a second request waits for the promise already in
   * flight instead of racing the marker and reporting a false failure.
   */
  private prepareKit(): Promise<boolean> {
    if (!this.workspace) return Promise.resolve(true);
    this.kitPreparing ??= this.runPrepareKit().finally(() => {
      this.kitPreparing = undefined;
    });
    return this.kitPreparing;
  }
  private async runPrepareKit(): Promise<boolean> {
    try {
      const kit = await initializeKit(this.workspace!.root, this.data, this.kitSource);
      this.kitProblem = undefined;
      this.kitDetail = undefined;
      // A copy that works makes the old failure notice wrong: it said to reopen
      // the app, and that is no longer true.
      if (this.notice === KIT_NOT_READY) {
        this.notice = undefined;
        this.publish({ type: "snapshot", state: this.snapshot() });
      }
      if (kit.skillsError)
        this.notice =
          "No pude poner al día las guías de trabajo del kit. Podés seguir trabajando; si faltan, reiniciá Bitácora.";
      return true;
    } catch (error) {
      this.kitProblem = KIT_NOT_READY;
      this.kitDetail = String(error);
      this.notice = this.kitProblem;
      return false;
    }
  }
  /**
   * Refuses a new request while another one is running (or waiting on a
   * question). Used before starting and again after any wait, because the state
   * can change while a request is preparing the kit.
   */
  private refuseWhileBusy(reply: (message: ServerMessage) => void): boolean {
    if (!this.submitting && !this.works.some((work) => work.busy)) return false;
    const asking = this.works.find((work) => work.busy && work.question && !work.question.closed);
    reply(asking
      ? { type: "problem", text: `Te hice una pregunta en «${asking.title}»: respondela para seguir.`, workId: asking.id }
      : { type: "problem", text: "Esperá a que termine el pedido actual o pausalo." });
    return true;
  }
  async initialize() {
    await mkdir(this.data, { recursive: true });
    await this.workspace?.initialize();
    if (this.workspace) await this.prepareKit();
    try {
      const saved = JSON.parse(
        await readFile(join(this.data, "works.json"), "utf8"),
      );
      if (!saved || saved.version !== 1 || !Array.isArray(saved.works) || !saved.works.every(isSavedWork))
        throw new SyntaxError("Invalid saved work list");
      this.works = saved.works;
      this.backupReceipt = typeof saved.backupReceipt === "string" ? saved.backupReceipt : undefined;
      // A work whose first request was paused or failed before it could be
      // titled stays pending across restarts, so its next finished request
      // still names it. A name the user chose is final across restarts too.
      for (const work of this.works) {
        if (work.titlePending) this.titlePending.add(work.id);
        if (work.renamedByUser) this.renamed.add(work.id);
      }
      for (const work of this.works) {
        if (work.busy) {
          work.busy = false;
          work.progress =
            "El trabajo se detuvo al cerrar la app. Podés continuarlo.";
        }
        // The app-server that asked is gone: the question cannot be answered.
        this.closeQuestion(work, "closed");
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        const source = join(this.data, "works.json");
        const target = join(this.data, `works.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        let preserved = true;
        try { await this.renameWithRetry(source, target); }
        catch {
          try { await this.files.copyFile(source, target); }
          catch { preserved = false; }
        }
        this.works = [];
        this.notice = preserved
          ? "No pude leer los trabajos guardados. Conservé el archivo dañado por separado y abrí una lista vacía."
          : "No pude leer los trabajos guardados ni conservar una copia aparte. Abrí una lista vacía.";
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    if (this.workspace) {
      try { this.backups = new Backups(this.workspace.root, this.data, BACKUP_LIMITS, this.workspace); await this.backups.initialize(this.backupReceipt); }
      catch { this.backups = undefined; this.notice = "No pude preparar las copias. Podés trabajar, pero esta vez no vas a poder deshacer."; }
      if (this.backups?.invalidated) this.notice = "No pude confirmar que la copia sea del último pedido. No voy a ofrecer Deshacer para esa copia.";
      if (this.backups?.restoring) this.notice = "Quedó un Deshacer pendiente. Podés reintentarlo o dejar la carpeta como está.";
    }
    for (const work of this.works) if (work.pendingFiles) { await this.collectResults(work); this.dirty = true; }
    await this.loadSettings();
    if (this.workspace) {
      // The profile is the agency's file, not a preference: it is read at each
      // start, so an edit the agent or the person made counts from then on.
      try {
        const profile = await readWelcomeProfile(this.workspace.root);
        this.uses = profile.uses;
        // A profile with names, or an agency that already has its brand, means
        // the questions were answered (or are not needed): a lost or damaged
        // `settings.json` does not make Bitácora ask them again.
        if (!this.settings.welcome && (profile.agency || profile.person)) this.settings.welcome = "done";
        if (!this.settings.welcome && existsSync(join(this.workspace.root, "marca", "datos.md"))) this.settings.welcome = "done";
      } catch { this.uses = []; this.addNotice("No pude leer el perfil de tu agencia. Las sugerencias son las de siempre."); }
    }
  }
  /**
   * A missing file only means nothing was chosen yet. A damaged one is set
   * aside like `works.json` and the defaults are used, saying so, so the next
   * save does not overwrite it unseen. A ruled-out model is dropped.
   */
  private async loadSettings() {
    const source = join(this.data, "settings.json");
    let text: string;
    try { text = await readFile(source, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.addNotice("No pude leer tus preferencias. Uso las de siempre.");
      return;
    }
    let saved: { version?: unknown; model?: unknown; panelWidth?: unknown; welcome?: unknown };
    try {
      saved = JSON.parse(text);
      if (!saved || typeof saved !== "object" || saved.version !== 1) throw new SyntaxError("Invalid settings");
    } catch {
      const target = join(this.data, `settings.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      let preserved = true;
      try { await this.renameWithRetry(source, target); }
      catch {
        try { await this.files.copyFile(source, target); }
        catch { preserved = false; }
      }
      this.addNotice(preserved
        ? "No pude leer tus preferencias. Guardé el archivo dañado aparte y volví a las de siempre."
        : "No pude leer tus preferencias. Volví a las de siempre.");
      return;
    }
    if (typeof saved.model === "string" && saved.model && isAllowedModel({ id: saved.model })) this.settings.model = saved.model;
    if (typeof saved.panelWidth === "number" && Number.isFinite(saved.panelWidth))
      this.settings.panelWidth = Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, saved.panelWidth)));
    if (saved.welcome === "done" || saved.welcome === "skipped") this.settings.welcome = saved.welcome;
  }
  /**
   * The welcome answers as a sentence for the agent's developer instructions,
   * with the values quoted and marked as data. A missing or unreadable profile
   * is not a failure: the base instructions already say to ask for the names.
   */
  private async developerNotes(): Promise<string | undefined> {
    if (!this.workspace) return undefined;
    try { return profileNotes(await readWelcomeProfile(this.workspace.root)); }
    catch { return undefined; }
  }
  private addNotice(text: string) {
    this.notice = this.notice ? `${this.notice} ${text}` : text;
  }
  private saveSettings() {
    const content = JSON.stringify({ version: 1, ...this.settings }, null, 2);
    this.settingsWrites = this.settingsWrites
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.data, "settings.json.tmp"), content, "utf8");
        await this.renameWithRetry(join(this.data, "settings.json.tmp"), join(this.data, "settings.json"));
      });
    return this.settingsWrites;
  }
  /**
   * Asks the engine which models the account has. It runs when the engine
   * starts or restarts, when the account changes and when the menu opens
   * without a fresh list. Only the latest answer counts. A failure keeps the
   * list it had, unless that list belongs to another account: then there is
   * no list, and the next request asks for the chosen model.
   */
  private async refreshModels() {
    const request = ++this.catalogueRequest;
    this.listing = true;
    this.publish({ type: "snapshot", state: this.snapshot() });
    try {
      const catalogue = await this.engine.models();
      if (request !== this.catalogueRequest) return;
      this.catalogue = catalogue;
      this.catalogueAt = Date.now();
      this.catalogueStale = false;
    } catch {
      if (request !== this.catalogueRequest) return;
      if (this.catalogueStale) this.catalogue = undefined;
    } finally {
      if (request === this.catalogueRequest) {
        this.listing = false;
        this.publish({ type: "snapshot", state: this.snapshot() });
      }
    }
  }
  /**
   * Takes the account the engine reports. When it is another one (other mail,
   * or connected now and not before) the list on hand is marked as the old
   * account's before it is replaced, whoever read it first: an account event
   * or a request.
   */
  private noteAccount(account: Account) {
    const previous = this.accountState;
    if (previous && (previous.connected !== account.connected || previous.email !== account.email))
      this.catalogueStale = true;
    this.accountState = account;
  }
  /** The list to choose from: none while the one on hand belongs to another account. */
  private listOnHand() {
    return this.catalogueStale ? undefined : this.catalogue;
  }
  /** The menu opened: ask again when there is no list, or it is old or from another account. */
  private refreshModelsIfStale() {
    if (this.listing) return;
    if (this.catalogue && !this.catalogueStale && Date.now() - this.catalogueAt < CATALOGUE_MAX_AGE_MS) return;
    void this.refreshModels();
  }
  async startEngine() {
    this.unsubscribe = this.engine.subscribe((event) => this.event(event));
    await this.engine.start();
    // Usable as soon as the engine is: the account read below must not keep a
    // ready protection looking stopped (see DEC-011).
    this.available = true;
    this.starting = false;
    this.publish({ type: "snapshot", state: this.snapshot() });
    void this.refreshModels();
    // Codex reports the account during start. Avoid a second read racing the
    // automatic MXC setup, which can replace the app-server.
    this.accountState ??= await this.engine.account();
    this.publish({ type: "snapshot", state: this.snapshot() });
  }
  snapshot(): Snapshot {
    return {
      account: (!this.starting && this.available && this.accountState) || { connected: false },
      engine: {
        available: !this.starting && this.available,
        starting: this.starting,
        exhausted: this.exhausted,
        safety: this.engine.executionSafety(),
      },
      hasBrand: this.workspace ? existsSync(join(this.workspace.root, "marca")) : undefined,
      notice: this.notice,
      undo: !this.submitting && !this.works.some(w => w.busy) ? this.backups?.target : undefined,
      fileRevision: this.fileRevision,
      model: { ...resolveModel(this.listOnHand(), this.settings.model).state, listing: this.listing },
      panelWidth: this.settings.panelWidth,
      welcome: this.workspace ? (this.settings.welcome ?? "pending") : undefined,
      uses: this.workspace ? [...this.uses] : undefined,
      works: this.works.map(({ conversationId: _, pendingFiles: __, titlePending: ___, renamedByUser: ____, ...work }) => work),
    };
  }
  private async renameWithRetry(source: string, target: string) {
    for (let attempt = 0; ; attempt++) {
      try { await this.files.rename(source, target); return; }
      catch (error) {
        if (attempt >= 3 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  }
  private changed() {
    const revision = ++this.writeRevision;
    this.dirty = false;
    const content = JSON.stringify({ version: 1, works: this.works, backupReceipt: this.backupReceipt }, null, 2);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(join(this.data, "works.json.tmp"), content, "utf8");
        await this.renameWithRetry(join(this.data, "works.json.tmp"), join(this.data, "works.json"));
      });
    // Report each failure while allowing the next write to recover. A failed
    // save stays unsaved so closing retries it instead of losing the change.
    void this.writes.catch((error) => {
      if (this.writeRevision === revision) this.dirty = true;
      this.publish({
        type: "problem",
        text: "No pude guardar el trabajo. No cierres la app todavía.",
        detail: String(error),
      });
    });
    this.publish({ type: "snapshot", state: this.snapshot() });
  }
  file(id: string) {
    return this.works.flatMap(w => w.messages.flatMap(m => [...(m.attachments || []), ...(m.results || [])])).find(f => f.id === id);
  }
  private scanDetail(work: SavedWork, scan: FileScan) {
    if (scan.warnings.length) work.details = (work.details + scan.warnings.join("\n") + "\n").slice(-100000);
  }
  private pendingPath(work: SavedWork) {
    if (!/^[a-zA-Z0-9-]+$/.test(work.id)) throw new Error('Invalid work identity');
    return join(this.data, 'pending-files', `${work.id}.json`);
  }
  private async collectResults(work: SavedWork) {
    const pending = work.pendingFiles;
    if (!pending || !this.workspace) return;
    try {
      const before = pending.before
        ? { entries: Object.fromEntries(Object.entries(pending.before).map(([p, hash]) => [p, { hash }])) } as FileScan
        : JSON.parse(await readFile(this.pendingPath(work), 'utf8')) as FileScan;
      let after: FileScan;
      if (this.backups) {
        const complete = await this.backups.finish();
        if (!complete) this.notice = "No pude guardar la copia de este pedido. Esta vez no vas a poder deshacer.";
        else if (this.backups.latestOmitted.length) this.notice = `No pude guardar copia de ${this.backups.latestOmitted.join(', ')}, así que eso no lo puedo deshacer.`;
        if (!this.backups.lastScan) throw new Error('File review unavailable');
        after = this.backups.lastScan;
      } else after = await this.workspace.scan(before);
      this.scanDetail(work, after);
      const message = work.messages.find(m => m.id === pending.messageId);
      const previous = new Map(Object.entries(before.entries).map(([p, entry]) => [pathKey(p), entry.hash]));
      const changed = Object.keys(after.entries).filter(p => this.workspace!.isResult(p) && after.entries[p].hash !== previous.get(pathKey(p)));
      // The backup keeps files up to its own limit, but a result the app cannot
      // serve must not become a card the user cannot open.
      const tooBig = changed.filter(p => after.entries[p].size > MAX_RESULT).map(p => basename(p));
      if (message) message.results = changed.filter(p => after.entries[p].size <= MAX_RESULT).map(p => this.workspace!.result(p));
      if (tooBig.length) {
        const notice = tooBig.length === 1
          ? `Se generó ${tooBig[0]}, pero es demasiado grande para mostrarlo acá.`
          : `Se generaron ${tooBig.join(', ')}, pero son demasiado grandes para mostrarlos acá.`;
        work.problem = work.problem ? `${work.problem} ${notice}` : notice;
      }
    } catch (error) {
      work.problem = "No pude revisar los resultados de ese pedido. Podés seguir trabajando.";
      work.details = (work.details + String(error) + "\n").slice(-100000);
    } finally {
      this.fileRevision++;
      delete work.pendingFiles;
      try { await rm(this.pendingPath(work), { force: true }); }
      catch (error) { work.details = (work.details + String(error) + "\n").slice(-100000); }
    }
  }
  private finishFiles(work: SavedWork) {
    if (!work.pendingFiles || !this.workspace || this.scanning.has(work.id)) return;
    work.busy = true;
    this.scanning.add(work.id);
    const scan = this.collectResults(work).finally(() => { work.busy = false; this.changed(); this.scans.delete(scan); this.scanning.delete(work.id); });
    this.scans.add(scan);
  }
  /**
   * Replaces the fallback name with the engine's short one, once, after the
   * first request. It never overwrites a name the user chose meanwhile, and a
   * failure leaves the fallback in place.
   *
   * The work stays pending until a title is applied or the sample answered
   * with no usable text: a sample that could not run (engine stopping, thread
   * busy, request error) is retried by the next finished request, even in a
   * later session: a start alone does not title it.
   */
  private clearTitlePending(work: SavedWork) {
    this.titlePending.delete(work.id);
    delete work.titlePending;
  }
  private async generateTitle(work: SavedWork) {
    if (!this.titlePending.has(work.id)) return;
    const before = work.title;
    let suggestion: SuggestedTitle | undefined;
    try { suggestion = await this.engine.suggestTitle(work.conversationId); }
    catch { return; }
    // Another sample for this work settled first (a second request finished
    // while this one was in flight): only one may name it.
    if (!this.titlePending.has(work.id)) return;
    // A name the user saved while the sample was in flight wins, even when it
    // is the same temporary name the work had.
    if (this.renamed.has(work.id)) return;
    // Someone else named the work, or the sample answered without text: there
    // is nothing left to wait for.
    if (work.title !== before || !suggestion) {
      this.clearTitlePending(work);
      this.changed();
      return;
    }
    work.title = suggestion.title;
    this.clearTitlePending(work);
    if (suggestion.usage)
      work.details = (work.details + `Título automático: ${suggestion.usage.input} de entrada (${suggestion.usage.cached} en caché), ${suggestion.usage.output} de salida.\n`).slice(-100000);
    this.changed();
    try { await this.engine.renameWork(work.conversationId, work.title); }
    catch (error) {
      work.details = (work.details + `No pude guardar el título en la sesión: ${String(error)}\n`).slice(-100000);
      this.changed();
    }
  }
  /**
   * Marks the question on screen as no longer answerable, saying why, and drops
   * the ones waiting behind it: they belong to the same turn.
   */
  private closeQuestion(work: SavedWork, reason: Parameters<typeof questionEndText>[0]) {
    this.queuedQuestions.delete(work.id);
    if (!work.question || work.question.closed) return false;
    work.question.closed = questionEndText(reason);
    return true;
  }
  /** Shows the next question in line, if any. True when one is waiting again. */
  private nextQuestion(work: SavedWork) {
    const queue = this.queuedQuestions.get(work.id);
    work.question = queue?.shift();
    if (!queue?.length) this.queuedQuestions.delete(work.id);
    if (work.question) work.progress = WAITING_ANSWER;
    return !!work.question;
  }
  private event(event: EngineEvent) {
    if (event.type === "protection") {
      this.publish({ type: "snapshot", state: this.snapshot() });
      return;
    }
    if (event.type === "availability") {
      this.available = event.available;
      // The engine publishes availability together with a decided protection.
      if (event.available) this.starting = false;
      this.exhausted = event.exhausted ?? false;
      this.resumed.clear();
      if (!event.available) {
        this.accountState = { connected: false };
        for (const work of this.works) {
          if (work.busy) {
            work.busy = false;
            work.progress =
              "Bitácora se detuvo. Podés continuar cuando vuelva.";
          }
          this.closeQuestion(work, "stopped");
        }
      }
      if (!event.available) for (const work of this.works) this.finishFiles(work);
      this.changed();
      if (event.available) void this.refreshModels();
      return;
    }
    if (event.type === "account") {
      this.noteAccount(event.account);
      this.publish({ type: "snapshot", state: this.snapshot() });
      if (this.available) void this.refreshModels();
      return;
    }
    const work =
      "conversationId" in event && event.conversationId
        ? this.works.find((w) => w.conversationId === event.conversationId)
        : event.type === "detail"
          ? this.works.find((w) => w.busy)
          : undefined;
    if (!work) {
      // Nobody can see a question without its work: the agent is told no one
      // answered instead of waiting forever.
      if (event.type === "question")
        void this.engine.answer(event.conversationId, event.id, {}).catch(() => {});
      if (event.type === "detail" && !event.conversationId) {
        this.pendingDetails.push({ text: event.text, key: event.key });
        if (this.pendingDetails.length > 50) {
          // A notice the cap pushes out is never shown, so the engine has to
          // say it again: its key cannot stay as if it had been said.
          const dropped = this.pendingDetails.shift();
          if (dropped?.key) this.engine.forgetDetails([dropped.key]);
        }
      } else if (event.type === "problem")
        this.publish({
          type: "problem",
          text: !this.available ? "Bitácora se detuvo. Tus trabajos siguen guardados." : problemText(event.kind),
          detail: event.detail,
        });
      return;
    }
    switch (event.type) {
      case "title":
        if (!this.renamed.has(work.id)) work.title = event.title;
        break;
      case "progress":
        work.progress = activityText[event.activity];
        break;
      case "message": {
        const message = work.messages.find((m) => m.id === event.id);
        if (message)
          message.text = event.delta ? message.text + event.text : event.text;
        else
          work.messages.push({
            id: event.id,
            role: "assistant",
            text: event.text,
          });
        break;
      }
      case "detail":
        work.details = (work.details + event.text + "\n").slice(-100000);
        break;
      case "question": {
        const question = { id: event.id, askedAt: new Date().toISOString(), questions: event.questions };
        if (work.question && !work.question.closed) {
          this.queuedQuestions.set(work.id, [...(this.queuedQuestions.get(work.id) ?? []), question]);
          return;
        }
        work.question = question;
        work.progress = WAITING_ANSWER;
        break;
      }
      case "questionClosed": {
        const queue = this.queuedQuestions.get(work.id)?.filter((q) => !event.ids.includes(q.id));
        if (queue?.length) this.queuedQuestions.set(work.id, queue);
        else this.queuedQuestions.delete(work.id);
        const current = work.question;
        if (!current || current.closed || !event.ids.includes(current.id)) break;
        // Only the one on screen stopped waiting: the next one takes its place.
        // When nothing is left behind it, the card stays closed with the notice.
        if (!this.nextQuestion(work)) work.question = { ...current, closed: questionEndText(event.reason) };
        break;
      }
      case "problem":
        work.problem = problemText(event.kind);
        work.details = (work.details + event.detail + "\n").slice(-100000);
        if (event.kind === "disconnected")
          this.accountState = { connected: false };
        break;
      case "finished":
        work.busy = false;
        this.finishFiles(work);
        if (event.status === "completed") work.problem = undefined;
        work.progress =
          event.status === "interrupted"
            ? "Trabajo pausado."
            : event.status === "failed"
              ? "El pedido no se pudo completar."
              : "Listo.";
        // Only a completed request has a conversation worth summarizing: a
        // failed or paused one keeps the fallback name, and the next completed
        // request titles the work instead.
        if (event.status === "completed") {
          const task = this.generateTitle(work);
          this.titleTasks.add(task);
          void task.catch(() => {}).finally(() => this.titleTasks.delete(task));
        }
        break;
    }
    work.updatedAt = new Date().toISOString();
    if (
      (event.type === "message" && event.delta) ||
      event.type === "detail" ||
      event.type === "progress"
    ) {
      this.dirty = true;
      if (!this.flushTimer)
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          if (this.dirty) this.changed();
        }, 1000);
      if (event.type === "message")
        this.publish({
          type: "message",
          workId: work.id,
          id: event.id,
          text: event.text,
          delta: event.delta,
        });
      else if (event.type === "progress")
        this.publish({ type: "snapshot", state: this.snapshot() });
    } else this.changed();
  }
  async command(
    command: ClientCommand,
    reply: (message: ServerMessage) => void,
  ) {
    if (command.type === "undo" || command.type === "discardUndo") {
      if (this.submitting || this.works.some(w => w.busy) || !this.backups) {
        reply({ type: "problem", text: this.backups ? "Esperá a que termine el pedido actual para deshacer." : "No hay una copia disponible para deshacer." }); return;
      }
      this.submitting = true;
      const undoWork = this.works.find(w => w.id === this.backups!.target?.workId);
      if (undoWork) undoWork.details += `Papelera de Bitácora: ${this.backups.trashLocation}\n`;
      this.changed();
      try {
        const result = command.type === "discardUndo" ? await this.backups.discard(command.id) : await this.backups.undo(command.id);
        this.notice = `Listo. Deshice ${result.restored.length} cambios. Lo que agregaste o cambiaste después quedó como estaba.`;
        if ('remaining' in result && Array.isArray(result.remaining)) this.notice = `Dejé la carpeta como está. Podés seguir trabajando. Quedó revertido: ${result.restored.map(p => p.split(/[\\/]/).at(-1)).join(', ') || 'ningún archivo'}. No quedó revertido: ${result.remaining.join(', ') || 'ningún archivo'}.`;
        if (result.skipped.length) this.notice += ` Dejé ${result.skipped.length} sin tocar porque cambiaron después: ${result.skipped.join(', ')}.`;
        if (result.omitted.length) this.notice += ` No pude guardar copia de ${result.omitted.join(', ')}, así que eso no lo puedo deshacer.`;
        const reverted = this.works.find(w => w.id === result.target.workId)?.messages.find(m => m.id === result.target.messageId);
        for (const file of reverted?.results || []) if (result.restored.includes(file.path)) file.reverted = true;
      } catch (error) {
        this.notice = error instanceof RestoreProblem ? error.message : this.backups.restoring
          ? "No pude completar Deshacer. Podés reintentar o dejar la carpeta como está."
          : "No pude empezar Deshacer. Podés seguir trabajando o volver a intentarlo.";
      } finally { this.fileRevision++; this.submitting = false; this.changed(); }
      return;
    }
    if (command.type === "prepareProtection") {
      if (this.starting || !this.available || this.submitting || this.works.some(w => w.busy)) return;
      await this.engine.prepareProtection();
      return;
    }
    if (command.type === "retry") {
      await this.engine.retry();
      return;
    }
    if (command.type === "connect") {
      if (this.starting || this.engine.executionSafety().status === "preparing") {
        reply({ type: "problem", text: "Estoy preparando la protección de tu compu. Esperá un momento y volvé a intentar conectar." });
        return;
      }
      reply({ type: "login", ...(await this.engine.connectAccount()) });
      return;
    }
    if (command.type === "welcome" || command.type === "skipWelcome") {
      if (!this.workspace) throw new Error("Welcome unavailable");
      // Another window answered first, or the previous answer is still being
      // saved: the first one wins. Checked synchronously, before any await, so
      // two commands that arrive together cannot both pass.
      if (this.settings.welcome || this.welcomeSaving) return;
      this.welcomeSaving = true;
      try {
        if (command.type === "welcome") {
          let answers: WelcomeAnswers;
          try { answers = welcomeAnswers(command.answers); }
          catch (error) {
            if (error instanceof WelcomeProblem) { reply({ type: "problem", text: error.message }); return; }
            throw error;
          }
          try { await saveWelcomeProfile(this.workspace.root, answers); }
          catch (error) {
            reply({ type: "problem", text: "No pude guardar tus respuestas en la carpeta de tu agencia. Probá de nuevo o salteá la bienvenida.", detail: String(error) });
            return;
          }
          this.uses = answers.uses;
        }
        this.settings.welcome = command.type === "welcome" ? "done" : "skipped";
        this.publish({ type: "snapshot", state: this.snapshot() });
        try { await this.saveSettings(); }
        catch (error) {
          reply({
            type: "problem",
            text: command.type === "welcome"
              ? "Guardé tus respuestas, pero no pude recordar que la bienvenida ya está hecha."
              : "Seguimos, pero no pude recordar que salteaste la bienvenida.",
            detail: String(error),
          });
        }
      } finally { this.welcomeSaving = false; }
      return;
    }
    if (command.type === "rename") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      const title = typeof command.title === "string" ? command.title.trim().replace(/\s+/g, " ") : "";
      if (!title || title.length > MAX_TITLE) {
        reply({ type: "problem", text: `Escribí un nombre de hasta ${MAX_TITLE} letras.` });
        return;
      }
      work.title = title;
      // A chosen name is final: no automatic title replaces it later, not even
      // one the engine reports after a restart.
      this.titlePending.delete(work.id);
      delete work.titlePending;
      work.renamedByUser = true;
      this.renamed.add(work.id);
      this.changed();
      try { await this.engine.renameWork(work.conversationId, title); }
      catch (error) {
        work.details = (work.details + `No pude guardar el nombre en la sesión: ${String(error)}\n`).slice(-100000);
        this.changed();
      }
      return;
    }
    if (command.type === "chooseModel") {
      const choices = resolveModel(this.listOnHand(), this.settings.model).state.choices;
      if (!choices.some((choice) => choice.id === command.model)) {
        reply({ type: "problem", text: "Ese modelo no está disponible en tu cuenta. Elegí otro de la lista." });
        return;
      }
      this.settings.model = command.model;
      this.publish({ type: "snapshot", state: this.snapshot() });
      try { await this.saveSettings(); }
      catch (error) {
        reply({ type: "problem", text: "Cambié el modelo, pero no pude guardarlo para la próxima vez.", detail: String(error) });
      }
      return;
    }
    if (command.type === "refreshModels") {
      if (this.available) this.refreshModelsIfStale();
      return;
    }
    if (command.type === "panelWidth") {
      if (typeof command.width !== "number" || !Number.isFinite(command.width)) throw new Error("Invalid width");
      this.settings.panelWidth = Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, command.width)));
      // Not published: the window that dragged it already shows it, and the
      // next snapshot carries it to any other window.
      await this.saveSettings().catch(() => {});
      return;
    }
    if (command.type === "interrupt") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      // Nothing reached the engine yet: remember the pause for the moment the
      // request is sent, so it cannot run to completion in the meantime.
      if (this.unsent.has(work.id)) {
        this.pauseRequested.add(work.id);
        return;
      }
      await this.engine.interrupt(work.conversationId);
      return;
    }
    if (command.type === "answer" || command.type === "skipQuestion") {
      const work = this.works.find((w) => w.id === command.workId);
      if (!work) throw new Error("Unknown work");
      const question = work.question;
      // Already answered (another window, a second click) or closed: the
      // snapshot that follows already shows why, so nothing is said.
      if (!question || question.closed || question.id !== command.questionId) return;
      const given = command.type === "answer" && command.answers && typeof command.answers === "object" ? command.answers : {};
      const answers: Record<string, string[]> = {};
      if (command.type === "answer")
        for (const q of question.questions) {
          const answer = agentAnswer(q, Object.hasOwn(given, q.id) ? given[q.id] : undefined);
          if (!answer) {
            reply({ type: "problem", text: "Respondé cada pregunta antes de seguir." });
            return;
          }
          answers[q.id] = answer;
        }
      try {
        // «Ahora no» answers nothing, the way Codex resolves an unanswered
        // question; the developer instructions tell the agent what that means.
        await this.engine.answer(work.conversationId, question.id, answers);
      } catch (error) {
        // The engine stopped waiting meanwhile (a pause, a restart): its own
        // event closes the card with the notice.
        work.details = (work.details + `No pude enviar la respuesta: ${String(error)}\n`).slice(-100000);
        this.changed();
        return;
      }
      work.messages.push({
        id: randomUUID(),
        role: "user",
        text: command.type === "answer" ? answerRecord(question, given) : "Ahora no.",
      });
      if (!this.nextQuestion(work)) work.progress = activityText.preparing;
      work.updatedAt = new Date().toISOString();
      this.changed();
      return;
    }
    if (
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 20000
    )
      throw new Error("Invalid request");
    if (this.backups?.restoring) { reply({ type: "problem", text: "Primero elegí Reintentar deshacer o Dejar la carpeta como está." }); return; }
    if (this.refuseWhileBusy(reply)) return;
    if (this.starting || !this.available || !this.engine.executionSafety().allowed) {
      const safety = this.engine.executionSafety();
      reply({
        type: "problem",
        text: this.starting
          ? "Esperá a que Bitácora termine de prepararse para enviar el pedido."
          : !this.available
            ? "Bitácora está detenida. Esperá a que vuelva para enviar el pedido."
            : safety.issue === "readBlock"
              ? "No pude activar el bloqueo que impide leer archivos fuera de tu carpeta. Sin eso no puedo empezar tus pedidos. Tocá Reintentar para volver a intentarlo."
              : "No puedo enviar pedidos porque la protección de la carpeta no está preparada. Hace falta completar la preparación de Windows.",
        detail: safety.detail,
      });
      return;
    }
    const uploads = this.workspace?.validate(command.attachments);
    if (command.attachments?.length && !this.workspace) throw new Error("Attachments unavailable");
    // The kit carries the agency rules, so a request does not run without it.
    // The copy is tried again here: the file that failed may be free by now,
    // and the notice stays until it works.
    if (this.kitProblem && !(await this.prepareKit())) {
      this.notice = this.kitProblem;
      reply({ type: "problem", text: this.kitProblem, detail: this.kitDetail });
      return;
    }
    // The wait above may have been long enough for another request to start:
    // only one request at a time may touch the backups and the pending files.
    if (this.refuseWhileBusy(reply)) return;
    this.submitting = true;
    let work: SavedWork | undefined;
    let attachments: FileRef[] = [];
    let committed = false;
    let newWork = false;
    // Notices without a work wait here for the next one. A request that fails
    // before it commits leaves the queue exactly as it found it: the notices it
    // queued are dropped and the older ones stay for the work that is sent.
    const queuedDetails = [...this.pendingDetails];
    try {
      const account = await this.engine.account();
      const wasCurrent = !this.catalogueStale;
      this.noteAccount(account);
      // Another account since the last list: that list is not this one's.
      if (wasCurrent && this.catalogueStale && this.available) void this.refreshModels();
      // Chosen after the account read, so another account's list is not used,
      // and kept for the whole request even if the user changes it meanwhile.
      const model = resolveModel(this.listOnHand(), this.settings.model).selection;
      this.publish({ type: "snapshot", state: this.snapshot() });
      if (!account.connected) {
        reply({ type: "problem", text: problemText("disconnected") });
        return;
      }
      // What the welcome knows travels with the thread, quoted as data, so the
      // agent does not ask again and does not read `perfil.md` every time.
      if (command.workId) {
        work = this.works.find((w) => w.id === command.workId);
        if (!work) throw new Error("Unknown work");
        if (!this.resumed.has(work.id)) {
          await this.engine.resumeWork(work.conversationId, model, await this.developerNotes());
          this.resumed.add(work.id);
        }
      } else {
        const created = await this.engine.createWork(model, await this.developerNotes());
        const now = new Date().toISOString();
        work = {
          id: randomUUID(),
          title: created.title || fallbackTitle(command.text),
          conversationId: created.conversationId,
          createdAt: now,
          updatedAt: now,
          messages: [],
          details: "",
          busy: false,
          progress: "",
        };
        newWork = true;
        // A name the engine already provides is used as is.
        if (!created.title) {
          work.titlePending = true;
          this.titlePending.add(work.id);
        }
      }
      attachments = await this.workspace?.attach(work.id, uploads || []) || [];
      const messageId = randomUUID();
      if (this.workspace) this.backupReceipt = randomUUID();
      this.notice = undefined;
      let before: FileScan | undefined;
      if (this.backups) {
        if (!await this.backups.before({ workId: work.id, title: work.title, request: command.text.trim().slice(0, 160), messageId }, this.backupReceipt)) this.notice = "No pude guardar la copia de este pedido. Esta vez no vas a poder deshacer.";
        before = this.backups.lastScan || { entries: {}, warnings: ["No pude revisar todos los resultados."], hashedBytes: 0, visited: 0 };
      } else before = await this.workspace?.scan().catch(() => ({ entries: {}, warnings: ["No pude revisar todos los resultados."], hashedBytes: 0, visited: 0 }));
      if (before) {
        this.scanDetail(work, before);
        await mkdir(join(this.data, 'pending-files'), { recursive: true });
        await writeFile(this.pendingPath(work), JSON.stringify(before), 'utf8');
        work.pendingFiles = { messageId };
      }
      if (newWork) { this.works.unshift(work); this.resumed.add(work.id); }
      if (this.pendingDetails.length) {
        // Delivered here, so the engine keeps the keys as said.
        const texts = this.pendingDetails.splice(0).map((detail) => detail.text);
        work.details = (work.details + texts.join("\n") + "\n").slice(-100000);
      }
      committed = true;
      work.messages.push({
        id: messageId,
        attachments,
        role: "user",
        text: command.text.trim(),
      });
      work.busy = true;
      work.problem = undefined;
      // A question left unanswered stays on screen until the next request.
      work.question = undefined;
      this.queuedQuestions.delete(work.id);
      work.progress = "Preparando la respuesta…";
      this.unsent.add(work.id);
      this.changed();
      await this.writes;
      reply({ type: "selected", workId: work.id });
      await rememberUserUrls(this.data, command.text);
      const engineFiles = await Promise.all((attachments || []).map(async f => ({ path: await this.workspace!.safePath(f.path), mime: f.mime })));
      this.unsent.delete(work.id);
      const sending = this.engine.send(work.conversationId, command.text.trim(), engineFiles, { filesReverted: this.backups?.hasNotice(work.id), model });
      if (this.pauseRequested.delete(work.id)) await this.engine.interrupt(work.conversationId);
      await sending;
      if (this.backups?.hasNotice(work.id)) {
        try { await this.backups.acknowledge(work.id); }
        catch { work.details += "No pude guardar que la sesión recibió el aviso de Deshacer.\n"; }
      }
    } catch (error) {
      if (work) {
        this.unsent.delete(work.id);
        this.pauseRequested.delete(work.id);
      }
      if (error instanceof EngineFailure && error.kind === "disconnected")
        this.accountState = { connected: false };
      if (!committed) {
        // The notices this request queued never reached a work: they would show
        // up under the next one, so they are dropped with the request and the
        // engine is told to say them again. The queue goes back exactly as it
        // was, including what the cap had pushed out meanwhile.
        const dropped = this.pendingDetails.filter((detail) => !queuedDetails.includes(detail));
        this.pendingDetails = queuedDetails;
        this.engine.forgetDetails(
          dropped.flatMap((detail) => (detail.key ? [detail.key] : [])),
        );
        await this.workspace?.removeAttachments(attachments);
        if (work) {
          // Only a work created by this request is discarded: an existing one
          // keeps its own flags, including a pending title.
          if (newWork) this.clearTitlePending(work);
          delete work.pendingFiles;
          await rm(this.pendingPath(work), { force: true });
        }
      }
      if (work && committed) {
        work.busy = false;
        work.problem = problemText(
          error instanceof EngineFailure ? error.kind : "other",
        );
        work.progress =
          "El pedido se detuvo. Revisá el detalle antes de volver a enviarlo.";
        work.details += String(error) + "\n";
        this.finishFiles(work);
        this.changed();
      }
      throw error;
    } finally {
      this.submitting = false;
      this.publish({ type: "snapshot", state: this.snapshot() });
    }
  }
  async close() {
    clearTimeout(this.flushTimer);
    // The desktop shell gives us a short grace period. Queue the current
    // transcript before waiting for titles, scans or Codex shutdown.
    for (const work of this.works) {
      if (this.closeQuestion(work, "closed")) this.dirty = true;
      if (!work.busy || this.scanning.has(work.id)) continue;
      work.busy = false;
      work.progress = "El trabajo se detuvo al cerrar la app. Podés continuarlo.";
      this.dirty = true;
    }
    if (this.dirty) this.changed();
    // A title already on its way gets a short, bounded chance to finish before
    // the engine stops. If it does not, the work stays pending and the next
    // start titles it.
    await Promise.race([
      Promise.all([...this.titleTasks].map((task) => task.catch(() => {}))),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TITLE_CLOSE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    await this.engine.close();
    this.unsubscribe?.();
    await Promise.all(this.scans);
    // Stopping the engine settles whatever title request was still in flight,
    // so nothing writes after close() returns.
    await Promise.all([...this.titleTasks].map((task) => task.catch(() => {})));
    clearTimeout(this.flushTimer);
    // Wait for the last write so a failure marks the change as unsaved, then
    // retry it before closing.
    await this.writes.catch(() => {});
    if (this.dirty) this.changed();
    await this.settingsWrites.catch(() => {});
    await this.writes;
  }
}
