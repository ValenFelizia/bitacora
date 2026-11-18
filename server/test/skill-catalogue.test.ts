// What the model really receives, without inference: a local server answers the
// Responses API and records the request, so the skill catalogue can be checked
// on the real Codex binary (DEC-011, issue #50).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { appServerArgs } from "../src/codex/engine";
import { codexBinary } from "../../scripts/codex-runtime.mjs";

/**
 * A local model that answers with one short message and keeps every request
 * body. Codex reaches it through a custom provider, so no account is used.
 */
async function localModel() {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      bodies.push(body);
      if (!req.url?.includes("responses")) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      const item = {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      };
      const response = {
        id: "resp_probe",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "probe",
        output: [item],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "ok" },
        { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "ok", annotations: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { bodies, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) || /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key))
      delete env[key];
  }
  env.CODEX_HOME = home;
  env.PROBE_KEY = "probe";
  return env;
}

/** Runs one turn on the real app-server and returns what the model received. */
async function modelRequests(args: string[], home: string, workspace: string, bodies: string[]) {
  const child = spawn(codexBinary(), args, {
    cwd: workspace,
    env: isolatedEnv(home),
    windowsHide: true,
    stdio: "pipe",
  });
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  const completed: (() => void)[] = [];
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const resolvePending = pending.get(message.id);
      if (resolvePending) { pending.delete(message.id); resolvePending(message); }
      return;
    }
    if (message.method === "turn/completed") completed.splice(0).forEach((resolveDone) => resolveDone());
  });
  const rpc = (method: string, params: unknown) =>
    new Promise<unknown>((resolveRpc, rejectRpc) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => rejectRpc(new Error(`RPC timeout: ${method}. ${stderr.slice(-2000)}`)),
        30000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        message.error ? rejectRpc(new Error(`${method}: ${message.error.message}`)) : resolveRpc(message.result);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const before = bodies.length;
  try {
    await rpc("initialize", {
      clientInfo: { name: "bitacora_catalogue_test", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const started = (await rpc("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
    })) as { thread: { id: string } };
    const done = new Promise<void>((resolveDone) => {
      completed.push(resolveDone);
      setTimeout(resolveDone, 15000).unref();
    });
    await rpc("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "hola", text_elements: [] }],
    });
    await done;
    // The request to the model can arrive a moment after the turn closes.
    const deadline = Date.now() + 5000;
    while (bodies.length === before && Date.now() < deadline) await delay(25);
    return bodies.slice(before).join("\n");
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(resolveExit, 2000).unref();
      });
      child.kill();
      await exited;
    }
  }
}

test(
  "real codex sends no skill catalogue to the model under Bitácora's arguments",
  { timeout: 120_000 },
  async () => {
    const model = await localModel();
    const base = await mkdtemp(join(tmpdir(), "bitacora-catalogue-"));
    const home = join(base, "codex");
    const workspace = join(base, "agencia");
    const skill = (name: string, description: string) =>
      `---\nname: ${name}\ndescription: ${description}\n---\nCuerpo.\n`;
    await mkdir(join(home, "skills", "user-skill"), { recursive: true });
    await writeFile(join(home, "skills", "user-skill", "SKILL.md"), skill("user-skill", "De la usuaria."), "utf8");
    await mkdir(join(workspace, ".agents", "skills", "kit-skill"), { recursive: true });
    await writeFile(join(workspace, ".agents", "skills", "kit-skill", "SKILL.md"), skill("kit-skill", "Del kit."), "utf8");
    await writeFile(
      join(home, "config.toml"),
      `model = "gpt-5.1-codex"\nmodel_provider = "probe"\nwindows.sandbox = "elevated"\n\n` +
        `[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:${model.port}/v1"\n` +
        `wire_api = "responses"\nenv_key = "PROBE_KEY"\n`,
      "utf8",
    );
    try {
      // Bitácora's own arguments: the catalogue never reaches the model.
      const curated = await modelRequests(appServerArgs("elevated"), home, workspace, model.bodies);
      assert.ok(curated.length > 0, "the model was asked");
      assert.doesNotMatch(curated, /kit-skill/);
      assert.doesNotMatch(curated, /user-skill/);

      // Control: with the catalogue on, the same skill does reach the model.
      // Without this, the check above would pass for the wrong reason.
      const control = await modelRequests(
        ["app-server", "--listen", "stdio://", "-c", "skills.bundled.enabled=false", "-c", "skills.include_instructions=true"],
        home,
        workspace,
        model.bodies,
      );
      assert.match(control, /kit-skill/);
      assert.match(control, /user-skill/);
    } finally {
      await model.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
);
