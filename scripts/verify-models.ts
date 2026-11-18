// Asks the pinned Codex binary for the account's model catalogue and how a
// thread takes the model. Only `initialize`, `account/read`, `config/read`,
// `model/list` and an ephemeral `thread/start` in a throwaway home: no turn, so
// no model request and no quota. The catalogue comes from the installed
// Bitácora's CODEX_HOME (its login) unless BITACORA_DATA_DIR points elsewhere.
// The account e-mail is never written to the evidence.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexBinary, codexVersion } from "./codex-runtime.mjs";
import { paths } from "../server/src/paths";
import { appServerArgs } from "../server/src/codex/engine";

type Reply = { result?: unknown; error?: unknown };

function appServer(home: string, cwd: string, backend?: "elevated") {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  const child = spawn(codexBinary(), appServerArgs(backend), { env, cwd, windowsHide: true, stdio: "pipe" });
  let nextId = 0;
  const pending = new Map<number, (message: Reply) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) pending.get(message.id)?.(message);
    else if (process.env.VERIFY_MODELS_DEBUG) console.error(line.slice(0, 400));
  });
  if (process.env.VERIFY_MODELS_DEBUG) child.stderr.on("data", (chunk) => console.error(String(chunk).slice(0, 400)));
  const rpc = (method: string, params: unknown) =>
    new Promise<Reply>((done) => {
      const id = ++nextId;
      const timer = setTimeout(() => done({ error: `no answer to ${method} in 30 s` }), 30_000);
      pending.set(id, (message) => { clearTimeout(timer); done(message); });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  return {
    rpc,
    async initialize() {
      await rpc("initialize", {
        clientInfo: { name: "bitacora", title: "Bitácora", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    },
    close: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.stdin.end();
        setTimeout(() => child.kill(), 1500).unref();
      }),
  };
}

/** `thread/start` has `model` but no `effort`: the effort travels as a config override. */
async function threadStartChecks() {
  const base = await mkdtemp(join(tmpdir(), "bitacora-models-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(base, "codex"), { recursive: true });
  // The throwaway home has no Windows sandbox set up, so the thread runs
  // read-only without the profile: only the model and the effort are measured.
  const server = appServer(join(base, "codex"), workspace, "elevated");
  try {
    await server.initialize();
    const start = async (params: Record<string, unknown>) => {
      const reply = await server.rpc("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, ...params });
      const result = reply.result as { model?: string; reasoningEffort?: string } | undefined;
      return { params, error: reply.error ?? null, model: result?.model ?? null, reasoningEffort: result?.reasoningEffort ?? null };
    };
    return [
      await start({}),
      await start({ model: "gpt-6.2-sol" }),
      await start({ model: "gpt-6.2-sol", config: { model_reasoning_effort: "high" } }),
    ];
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const { codexHome } = paths();
const server = appServer(codexHome, process.cwd());
try {
  await server.initialize();
  const rpc = server.rpc;
  const account = (await rpc("account/read", { refreshToken: false })).result as { account?: { type?: string; planType?: string } };
  const visible = await rpc("model/list", {});
  const hidden = await rpc("model/list", { includeHidden: true });
  const config = (await rpc("config/read", { includeLayers: false })).result as { config?: Record<string, unknown> };
  const summary = (list: { result?: unknown; error?: unknown }) =>
    list.error ?? ((list.result as { data: Record<string, unknown>[] }).data).map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      hidden: model.hidden,
      isDefault: model.isDefault,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      upgrade: model.upgrade,
    }));
  const evidence = {
    checkedAt: new Date().toISOString(),
    version: codexVersion,
    accountType: account?.account?.type ?? null,
    planType: account?.account?.planType ?? null,
    configModel: config?.config?.model ?? null,
    configEffort: config?.config?.model_reasoning_effort ?? null,
    modelList: summary(visible),
    modelListIncludingHidden: summary(hidden),
    threadStart: await threadStartChecks(),
    modelTurns: 0,
  };
  const out = resolve("docs/verification/issue57/model-list.json");
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence.threadStart, null, 2));
} finally {
  await server.close();
}
