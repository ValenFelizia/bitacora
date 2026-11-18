// Curated agency environment tests (DEC-011): unit checks, fake-engine check,
// and real Codex binary verification without inference or login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENCY_DEVELOPER_INSTRUCTIONS,
  AGENCY_ENVIRONMENT,
  isAllowedSkill,
} from "../src/agency-environment";
import { App } from "../src/app";
import { CodexEngine, PERMISSIONS_PROFILE, appServerArgs } from "../src/codex/engine";
import { codexEnvironmentArgs } from "../src/codex/environment";
import { registerKit } from "../src/codex/kit";
import { codexBinary } from "../../scripts/codex-runtime.mjs";
import { WorkspaceFiles } from "../src/workspace-files";
import { fakeAppServerArgs } from "./fake-app-server";

/**
 * Exact set of features expected to remain enabled in `codex features list`
 * under Bitácora's curated arguments on Codex 0.168.0. Any newly enabled
 * default in a future Codex version fails the test and must be reviewed.
 */
const EXPECTED_ENABLED_FEATURES = [
  "api_key_cyber_access_programs",
  "api_key_model_discovery",
  "auth_elicitation",
  "bedrock_setup_wizard",
  "browser_annotation_api",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "cli_daybreak",
  "code_mode_host",
  "code_mode_interrupt",
  "collaboration_modes",
  "compaction_image_budget",
  "computer_use",
  "content_item_kinds",
  "daemon_auto_start",
  "default_mode_request_user_input",
  "deferred_tool_world_state",
  "enable_request_compression",
  "fast_mode",
  "goals",
  "guardian_approval",
  "guardian_include_additional_context",
  "guardian_reuse_parent_compaction",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "in_app_updates",
  "in_app_voice",
  "incremental_tools",
  "instant_interrupt",
  "item_ids",
  "mcp_oauth_refresh_coordination",
  "mentions_v2",
  "prediction_preserve_parent_tools",
  "realtime_conversation",
  "reasoning_effort_override",
  "resize_all_images",
  "retain_client_tool_outputs",
  "secret_auth_storage",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "sqlite",
  "steer",
  "system_proxy_fallback",
  "terminal_resize_reflow",
  "tool_call_mcp_elicitation",
  "tool_search_always_defer_mcp_tools",
  "tui_app_server",
  "ultrafast_mode",
  "unbounded_connection_retries",
  "unified_exec",
  "unified_exec_tty",
  "unified_image_budget",
  "view_image",
  "workspace_dependencies",
  "worktrees",
  "write_stdin_approval",
];

function isolatedCodexEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(CODEX_|OPENAI_|ANTHROPIC_)/i.test(key) ||
      /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key)
    ) {
      delete env[key];
    }
  }
  env.CODEX_HOME = home;
  return env;
}

function containsSubsequence(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((value, offset) => haystack[i + offset] === value)) return true;
  }
  return false;
}

function stopCodexTree(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through if the process already exited.
    }
  }
  child.kill();
}

function startRealAppServer(args: string[], cwd: string, home: string) {
  const child = spawn(codexBinary(), args, {
    cwd,
    env: isolatedCodexEnv(home),
    windowsHide: true,
    stdio: "pipe",
  });
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  /** Requests and notifications the app-server sent, in order. */
  const incoming: { id?: number | string; method: string; params: any }[] = [];
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method) {
      incoming.push(message);
      return;
    }
    if (message.id !== undefined) {
      const resolvePending = pending.get(message.id);
      if (resolvePending) {
        pending.delete(message.id);
        resolvePending(message);
      }
    }
  });
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const id = ++nextId;
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolveRpc, rejectRpc) => {
      const timer = setTimeout(
        () => rejectRpc(new Error(`RPC timeout: ${method}. ${stderr.slice(-2000)}`)),
        30000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolveRpc(message);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result as T;
  };
  const close = async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        delay(1000).then(() => stopCodexTree(child)),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        stopCodexTree(child);
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
          setTimeout(resolveExit, 2000).unref();
        });
      }
    }
  };
  const respond = (id: number | string, result: unknown) =>
    child.stdin.write(JSON.stringify({ id, result }) + "\n");
  return { child, rpc, close, incoming, respond };
}

/**
 * A local stand-in for the model API: it answers each Responses request with
 * the next scripted reply and keeps the request bodies. No inference and no
 * account: the real app-server is pointed at it with a custom provider.
 */
async function mockResponses(replies: Array<(body: any) => object[]>) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw);
      bodies.push(body);
      const id = `resp-${bodies.length}`;
      const events = [
        { type: "response.created", response: { id } },
        ...(replies[bodies.length - 1] ?? replies.at(-1)!)(body),
        { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    bodies,
    args: [
      "-c", 'model="mock-model"',
      "-c", 'model_provider="bitacora_mock"',
      "-c", `model_providers.bitacora_mock={name="bitacora_mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
    ],
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

test("agency environment policy and developer instructions match DEC-011", () => {
  assert.equal(AGENCY_ENVIRONMENT.aiImages, true);
  assert.equal(AGENCY_ENVIRONMENT.webSearch, "cached");
  assert.equal(AGENCY_ENVIRONMENT.subagents, false);
  assert.equal(AGENCY_ENVIRONMENT.goals, true);
  assert.equal(AGENCY_ENVIRONMENT.questions, true);
  assert.equal(AGENCY_ENVIRONMENT.bundledSkills, false);
  assert.deepEqual(AGENCY_ENVIRONMENT.allowedSkills, []);
  assert.equal(AGENCY_ENVIRONMENT.pluginSuggestions, false);
  assert.deepEqual(AGENCY_ENVIRONMENT.allowedPlugins, []);
  assert.deepEqual(AGENCY_ENVIRONMENT.allowedConnectors, []);

  for (const scope of ["user", "repo", "system", "admin"]) {
    assert.equal(isAllowedSkill({ name: "any-skill", scope }), false);
  }
  assert.equal(
    isAllowedSkill(
      { name: "kit-skill", scope: "repo" },
      { ...AGENCY_ENVIRONMENT, allowedSkills: ["kit-skill"] },
    ),
    true,
  );
  assert.equal(
    isAllowedSkill(
      { name: "kit-skill", scope: "user" },
      { ...AGENCY_ENVIRONMENT, allowedSkills: ["kit-skill"] },
    ),
    false,
  );

  assert.doesNotMatch(AGENCY_DEVELOPER_INSTRUCTIONS, /No generes imágenes con IA/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /castellano rioplatense/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /si la usuaria te lo pide explícitamente/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /nunca presentes una imagen con IA.*foto real de un hotel o un destino/i);
});

test("codexEnvironmentArgs validates allowlist IDs and wires backends cleanly", () => {
  const defaults = codexEnvironmentArgs();
  for (const backend of [undefined, "mxc", "elevated"] as const) {
    assert.equal(containsSubsequence(appServerArgs(backend), defaults), true, String(backend));
  }
  assert.equal(
    appServerArgs("elevated").some((arg) => arg.includes(PERMISSIONS_PROFILE)),
    false,
  );

  for (const invalid of ["", "  ", "foo.bar", "foo=bar", " foo", 'foo"bar']) {
    assert.throws(
      () => codexEnvironmentArgs({ ...AGENCY_ENVIRONMENT, allowedPlugins: [invalid] }),
      /Invalid curated environment identifier/,
      invalid,
    );
    assert.throws(
      () => codexEnvironmentArgs({ ...AGENCY_ENVIRONMENT, allowedConnectors: [invalid] }),
      /Invalid curated environment identifier/,
      invalid,
    );
  }
});

test("real codex app-server resolves unquoted allowlist IDs in config/read", async () => {
  const base = await mkdtemp(join(tmpdir(), "bitacora-allowlist-"));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const args = appServerArgs("mxc", {
    ...AGENCY_ENVIRONMENT,
    allowedPlugins: ["canva@openai-curated"],
    allowedConnectors: ["google_drive"],
  });
  const server = startRealAppServer(args, workspace, home);
  try {
    await server.rpc("initialize", {
      clientInfo: { name: "bitacora_allowlist_test", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.child.stdin.write('{"method":"initialized"}\n');

    const { config } = await server.rpc<{
      config: {
        features?: Record<string, boolean | null>;
        include_apps_instructions?: boolean;
        plugins?: Record<string, { enabled?: boolean }>;
        apps?: Record<string, { enabled?: boolean }>;
      };
    }>("config/read", { includeLayers: false });

    assert.equal(config.features?.plugins, true);
    assert.equal(config.features?.apps, true);
    assert.equal(config.include_apps_instructions, true);
    assert.equal(config.features?.tool_suggest, false);
    assert.equal(config.plugins?._default?.enabled, false);
    assert.equal(config.plugins?.["canva@openai-curated"]?.enabled, true);
    assert.equal(config.plugins?.['"canva@openai-curated"'], undefined);
    assert.equal(config.apps?._default?.enabled, false);
    assert.equal(config.apps?.["google_drive"]?.enabled, true);
    assert.equal(config.apps?.['"google_drive"'], undefined);
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("CodexEngine passes curated -c overrides and updated developerInstructions", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/env-"));
  const log = join(dir, "protocol.jsonl");
  const spawnLog = join(dir, "spawns.jsonl");
  process.env.BITACORA_FAKE_LOG = log;
  process.env.BITACORA_FAKE_SPAWN = spawnLog;
  const engine = new CodexEngine({
    home: join(dir, "home"),
    workspace: join(dir, "workspace"),
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  try {
    await engine.start();
    await engine.createWork();
    await engine.resumeWork("thread-1");

    const spawns = (await readFile(spawnLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    assert.ok(spawns.length >= 1);
    for (const entry of spawns) {
      assert.equal(containsSubsequence(entry.args, codexEnvironmentArgs()), true);
    }

    const records = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: { developerInstructions?: string } });
    for (const method of ["thread/start", "thread/resume"]) {
      const call = records.find((r) => r.method === method);
      assert.ok(call, method);
      assert.equal(call.params?.developerInstructions, AGENCY_DEVELOPER_INSTRUCTIONS);
    }
  } finally {
    delete process.env.BITACORA_FAKE_LOG;
    delete process.env.BITACORA_FAKE_SPAWN;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("real codex features list matches the exact expected enabled feature set for DEC-011", async () => {
  const home = await mkdtemp(join(tmpdir(), "bitacora-features-"));
  try {
    const output = execFileSync(codexBinary(), [...codexEnvironmentArgs(), "features", "list"], {
      env: isolatedCodexEnv(home),
      encoding: "utf8",
      windowsHide: true,
    });
    const features = new Map<string, boolean>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(.+?)\s+(true|false)\s*$/);
      if (match) features.set(match[1], match[3] === "true");
    }

    assert.equal(features.get("image_generation"), true);
    assert.equal(features.get("view_image"), true);
    assert.equal(features.get("shell_tool"), true);
    assert.equal(features.get("unified_exec"), true);
    assert.equal(features.get("goals"), true);
    assert.equal(features.get("default_mode_request_user_input"), true);

    for (const off of [
      "plugins",
      "remote_plugin",
      "plugin_discovery_prefetch",
      "plugin_sharing",
      "tool_suggest",
      "recommended_plugins",
      "apps",
      "enable_mcp_apps",
      "apps_early_resource_discovery",
      "codex_apps_mcp_2026_07_28",
      "standalone_web_search",
      "multi_agent",
      "multi_agent_v2",
      "runtime_agent_instances",
    ]) {
      assert.equal(features.get(off), false, `expected feature ${off} to be false`);
    }

    const actualEnabled = [...features.entries()]
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(actualEnabled, [...EXPECTED_ENABLED_FEATURES].sort());
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test(
  "real codex app-server enforces DEC-011 without inference, keeps bitacora MCP healthy, and prevents catalogue clone",
  { timeout: 90_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "bitacora-appserver-env-"));
    const curatedHome = join(base, "curated-home");
    const curatedWorkspace = join(base, "curated-workspace");
    const controlHome = join(base, "control-home");
    const controlWorkspace = join(base, "control-workspace");
    await mkdir(curatedHome, { recursive: true });
    await mkdir(curatedWorkspace, { recursive: true });
    await mkdir(controlHome, { recursive: true });
    await mkdir(controlWorkspace, { recursive: true });
    await registerKit(curatedHome, curatedWorkspace);

    const curated = startRealAppServer(appServerArgs("mxc"), curatedWorkspace, curatedHome);
    const control = startRealAppServer(["app-server", "--listen", "stdio://"], controlWorkspace, controlHome);

    try {
      await Promise.all([
        curated.rpc("initialize", {
          clientInfo: { name: "bitacora_env_test", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
        control.rpc("initialize", {
          clientInfo: { name: "bitacora_control_test", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      ]);
      curated.child.stdin.write('{"method":"initialized"}\n');
      control.child.stdin.write('{"method":"initialized"}\n');

      const { config } = await curated.rpc<{
        config: {
          web_search: string | null;
          include_apps_instructions?: boolean;
          features?: Record<string, boolean | null>;
          plugins?: Record<string, { enabled?: boolean }>;
          apps?: Record<string, { enabled?: boolean }>;
          agents?: { enabled?: boolean };
          skills?: { bundled?: { enabled?: boolean }; include_instructions?: boolean };
        };
      }>("config/read", { includeLayers: false });

      assert.equal(config.web_search, "cached");
      assert.equal(config.include_apps_instructions, false);
      assert.equal(config.features?.image_generation, true);
      assert.equal(config.features?.plugins, false);
      assert.equal(config.features?.remote_plugin, false);
      assert.equal(config.features?.plugin_discovery_prefetch, false);
      assert.equal(config.features?.plugin_sharing, false);
      assert.equal(config.features?.tool_suggest, false);
      assert.equal(config.features?.apps, false);
      assert.equal(config.features?.multi_agent, false);
      assert.equal(config.features?.multi_agent_v2, false);
      assert.equal(config.features?.goals, true);
      assert.equal(config.features?.default_mode_request_user_input, true);
      assert.equal(config.plugins?._default?.enabled, false);
      assert.equal(config.apps?._default?.enabled, false);
      assert.equal(config.agents?.enabled, false);
      assert.equal(config.skills?.bundled?.enabled, false);
      assert.equal(config.skills?.include_instructions, false);

      const skills = await curated.rpc<{
        data: Array<{ skills: Array<{ name: string; scope: string; enabled: boolean }> }>;
      }>("skills/list", { cwds: [curatedWorkspace], forceReload: true });
      const systemSkills = skills.data.flatMap((entry) => entry.skills).filter((skill) => skill.scope === "system");
      assert.deepEqual(systemSkills, []);

      const mcp = await curated.rpc<{
        data: Array<{ name: string; toolsError: unknown; tools: Record<string, unknown> }>;
      }>("mcpServerStatus/list", {});
      const bitacora = mcp.data.find((server) => server.name === "bitacora");
      assert.ok(bitacora, "bitacora MCP server missing");
      assert.equal(bitacora.toolsError, null);
      assert.deepEqual(Object.keys(bitacora.tools).sort(), ["controlar", "dibujar", "traer"]);

      // Non-vacuous check: prove the uncurated control creates `.tmp/plugins` (or
      // at least begins the `.tmp/plugins-clone-*/.git` checkout on slow networks)
      // and `skills/.system` in the same startup window, while curated creates neither.
      const hasControlClone = () => {
        if (existsSync(join(controlHome, ".tmp", "plugins"))) return true;
        const tmpDir = join(controlHome, ".tmp");
        if (!existsSync(tmpDir)) return false;
        return readdirSync(tmpDir).some(
          (entry) => entry.startsWith("plugins-clone-") && existsSync(join(tmpDir, entry, ".git")),
        );
      };
      const deadline = Date.now() + 30_000;
      while (
        Date.now() < deadline &&
        (!existsSync(join(controlHome, ".tmp", "plugins")) ||
          !existsSync(join(controlHome, "skills", ".system")))
      ) {
        await delay(200);
      }
      assert.equal(
        hasControlClone(),
        true,
        "control app-server did not start or materialize .tmp/plugins within the startup window",
      );
      assert.equal(
        existsSync(join(controlHome, "skills", ".system")),
        true,
        "control app-server did not extract skills/.system within the startup window",
      );
      await delay(1000);
      assert.equal(existsSync(join(curatedHome, ".tmp")), false);
      assert.equal(existsSync(join(curatedHome, ".tmp", "plugins")), false);
      assert.equal(existsSync(join(curatedHome, "skills", ".system")), false);

      // Overrides live on the command line only, never written to config.toml.
      const configToml = await readFile(join(curatedHome, "config.toml"), "utf8");
      assert.doesNotMatch(configToml, /web_search|image_generation|multi_agent|tool_suggest|bundled/i);
    } finally {
      await Promise.all([curated.close(), control.close()]);
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
);

test(
  "real codex app-server offers goals, web search and questions outside Plan, and waits for the answer (no inference)",
  { timeout: 90_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "bitacora-questions-real-"));
    const home = join(base, "home");
    const workspace = join(base, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const ask = (callId: string) => () => [{
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [{
            id: "trato",
            header: "Trato",
            question: "¿Les hablás de vos o de usted?",
            options: [
              { label: "Vos (Recommended)", description: "Más cercano." },
              { label: "Usted", description: "Más formal." },
            ],
          }],
        }),
      },
    }];
    const say = () => [{
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", id: "msg", content: [{ type: "output_text", text: "Listo." }] },
    }];
    const model = await mockResponses([ask("call-1"), say, ask("call-2"), say]);
    // The arguments Bitácora gives a machine without MXC: no profile, so no
    // sandbox is needed for a turn that runs no command.
    const server = startRealAppServer([...appServerArgs("elevated"), ...model.args], workspace, home);
    const next = (predicate: (message: { method: string; params: any }) => boolean, label: string) =>
      (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const found = server.incoming.find(predicate);
          if (found) return found;
          await delay(25);
        }
        assert.fail(`timed out waiting for ${label}`);
      })();
    try {
      await server.rpc("initialize", {
        clientInfo: { name: "bitacora_questions_test", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.child.stdin.write('{"method":"initialized"}\n');
      const { config } = await server.rpc<{
        config: { web_search: string | null; features?: Record<string, boolean | null> };
      }>("config/read", { includeLayers: false });
      assert.equal(config.web_search, "cached");
      assert.equal(config.features?.goals, true);
      assert.equal(config.features?.default_mode_request_user_input, true);

      const { thread } = await server.rpc<{ thread: { id: string } }>("thread/start", {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        developerInstructions: AGENCY_DEVELOPER_INSTRUCTIONS,
      });
      const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];
      await server.rpc("turn/start", { threadId: thread.id, input: text("Armemos la marca") });

      // The question reaches the client and the turn waits for it.
      const request = await next((m) => m.method === "item/tool/requestUserInput", "the question");
      assert.equal(request.params.threadId, thread.id);
      assert.equal(request.params.isBlocking, false);
      assert.equal(request.params.questions[0].isOther, true);
      assert.deepEqual(request.params.questions[0].options.map((o: { label: string }) => o.label), ["Vos (Recommended)", "Usted"]);
      await delay(300);
      assert.equal(server.incoming.some((m) => m.method === "turn/completed"), false);
      assert.equal(model.bodies.length, 1);

      // What the model is offered in the default mode, with the agency's arguments.
      const tools = model.bodies[0].tools as Array<{ type: string; name?: string }>;
      const names = tools.map((tool) => tool.name ?? tool.type);
      for (const tool of ["request_user_input", "create_goal", "get_goal", "update_goal", "web_search"])
        assert.ok(names.includes(tool), `${tool} missing from ${names.join(", ")}`);

      // The answer goes back to the model as the tool's output.
      server.respond(request.id!, { answers: { trato: { answers: ["Vos (Recommended)"] } } });
      const completed = await next((m) => m.method === "turn/completed", "the first turn");
      assert.equal(completed.params.turn.status, "completed");
      const output = (model.bodies[1].input as Array<{ type: string; call_id?: string; output?: string }>)
        .find((item) => item.type === "function_call_output" && item.call_id === "call-1");
      assert.deepEqual(JSON.parse(output!.output!), { answers: { trato: { answers: ["Vos (Recommended)"] } } });
      const resolved = server.incoming.findIndex((m) => m.method === "serverRequest/resolved" && m.params.requestId === request.id);
      assert.ok(resolved >= 0 && resolved < server.incoming.indexOf(completed), "resolved before the turn ends");

      // A pause while the question waits ends the turn as interrupted and the
      // app-server stops waiting for the answer (in 0.168.0 it says so after
      // the turn ends). Nothing is left hanging.
      const seen = server.incoming.length;
      const second = await server.rpc<{ turn: { id: string } }>("turn/start", { threadId: thread.id, input: text("Otra cosa") });
      const pausedRequest = await next(
        (m) => server.incoming.indexOf(m as never) >= seen && m.method === "item/tool/requestUserInput",
        "the second question",
      );
      await server.rpc("turn/interrupt", { threadId: thread.id, turnId: second.turn.id });
      const interrupted = await next(
        (m) => server.incoming.indexOf(m as never) >= seen && m.method === "turn/completed",
        "the interrupted turn",
      );
      assert.equal(interrupted.params.turn.status, "interrupted");
      await next(
        (m) => m.method === "serverRequest/resolved" && m.params.requestId === pausedRequest.id,
        "the paused question to be resolved",
      );
    } finally {
      await server.close();
      await model.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
);

test(
  "CodexEngine disables user and repo skills on the real Codex binary without touching HOME/USERPROFILE",
  { timeout: 90_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "bitacora-real-skills-"));
    const home = join(base, "codex");
    const workspace = join(base, "workspace");
    await mkdir(join(home, "skills", "fake-user-skill"), { recursive: true });
    await mkdir(join(workspace, ".agents", "skills", "fake-repo-skill"), { recursive: true });
    await writeFile(
      join(home, "skills", "fake-user-skill", "SKILL.md"),
      "---\nname: fake-user-skill\ndescription: Synthetic user skill for test.\n---\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "fake-repo-skill", "SKILL.md"),
      "---\nname: fake-repo-skill\ndescription: Synthetic repo skill for test.\n---\n",
      "utf8",
    );
    await writeFile(join(home, "config.toml"), 'windows.sandbox = "elevated"\n', "utf8");

    const beforeHome = process.env.HOME;
    const beforeUserProfile = process.env.USERPROFILE;
    const engine = new CodexEngine({
      home,
      workspace,
      requestTimeoutMs: 60_000,
      probeProtection: async () => false,
    });
    const details: string[] = [];
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "detail") details.push(event.text);
    });

    try {
      await engine.start();
      const created = await engine.createWork();
      assert.ok(created.conversationId);
      // Only the synthetic skills are this test's business: the machine may
      // have its own skills in `~/.agents/skills`, and the test must not depend
      // on what they are or whether they can be turned off.
      assert.deepEqual(
        details.filter((text) => /fake-(user|repo)-skill/.test(text)),
        [],
        "the synthetic skills must be turned off without a notice",
      );
      assert.equal(process.env.HOME, beforeHome);
      assert.equal(process.env.USERPROFILE, beforeUserProfile);
    } finally {
      unsubscribe();
      await engine.close();
    }

    // Verify with a fresh app-server reading the same CODEX_HOME and workspace
    // that the synthetic user/repo skills were persisted as disabled, and that
    // any host skill discovered on this machine is off too.
    const verifier = startRealAppServer(appServerArgs("elevated"), workspace, home);
    try {
      await verifier.rpc("initialize", {
        clientInfo: { name: "bitacora_skills_verify", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      verifier.child.stdin.write('{"method":"initialized"}\n');

      const { data } = await verifier.rpc<{
        data: Array<{ skills: Array<{ name: string; scope: string; enabled: boolean }> }>;
      }>("skills/list", { cwds: [workspace], forceReload: true });
      const listed = data.flatMap((entry) => entry.skills);

      const userSkill = listed.find((s) => s.name === "fake-user-skill");
      const repoSkill = listed.find((s) => s.name === "fake-repo-skill");
      assert.ok(userSkill, "synthetic user skill should be listed");
      assert.equal(userSkill.scope, "user");
      assert.equal(userSkill.enabled, false);
      assert.ok(repoSkill, "synthetic repo skill should be listed");
      assert.equal(repoSkill.scope, "repo");
      assert.equal(repoSkill.enabled, false);
    } finally {
      await verifier.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
);

test("CodexEngine re-disables a skill that appears while a turn runs (skills/changed)", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-changed-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const skillsFile = join(dir, "skills.json");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const initialPath = join(home, "skills", "initial-user-skill", "SKILL.md");
  await writeFile(
    skillsFile,
    JSON.stringify([{ name: "initial-user-skill", description: "Initial", path: initialPath, scope: "user", enabled: true }]),
    "utf8",
  );
  process.env.BITACORA_FAKE_SKILLS_FILE = skillsFile;

  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const finished = new Promise<void>((resolveDone) => {
    const off = engine.subscribe((event) => {
      if (event.type === "finished") {
        off();
        resolveDone();
      }
    });
  });
  const readSkills = async () =>
    JSON.parse(await readFile(skillsFile, "utf8")) as Array<{ name: string; enabled: boolean }>;

  try {
    await engine.start();
    // The skill that existed at startup is turned off by the check that runs in
    // the background, and the work exists before the new one appears: only the
    // notification can turn that one off.
    await until(async () => (await readSkills()).every((skill) => !skill.enabled));
    const afterStart = await readSkills();
    assert.equal(afterStart.length, 1);

    const { conversationId } = await engine.createWork();
    assert.equal((await readSkills()).length, 1);
    await engine.send(conversationId, "skills-changed");
    await finished;

    const deadline = Date.now() + 5000;
    let updated: Array<{ name: string; enabled: boolean }> = [];
    while (Date.now() < deadline) {
      updated = await readSkills();
      if (updated.length === 2 && updated.every((skill) => !skill.enabled)) break;
      await delay(25);
    }
    assert.equal(updated.length, 2);
    assert.equal(updated.every((skill) => skill.enabled === false), true);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS_FILE;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * Waits until `predicate` is true. The tests that only look at what the app
 * shows cannot be written as a single await: the event they wait for arrives
 * while another promise is still open.
 */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(`condition timed out after ${timeoutMs}ms`);
}

/**
 * One fake app-server per test, with a skill that cannot be turned off in the
 * way the test asks for. Errors land in `work.details`, never in the app.
 */
async function withBrokenSkill(
  key: "BITACORA_FAKE_SKILL_WRITE_FAIL" | "BITACORA_FAKE_SKILL_KEEP_ENABLED",
  body: (details: () => Promise<string>) => Promise<void>,
) {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-error-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const data = join(dir, "data");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const skillPath = join(home, "skills", "broken-skill", "SKILL.md");
  process.env.BITACORA_FAKE_SKILLS = JSON.stringify([
    { name: "broken-skill", description: "Cannot be toggled", path: skillPath, scope: "user", enabled: true },
  ]);
  process.env[key] = skillPath;

  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const app = new App(engine, data, () => {});
  const details = async (): Promise<string> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const work = app.snapshot().works[0];
      if (work && !work.busy) return work.details;
      await delay(25);
    }
    return app.snapshot().works[0]?.details ?? "";
  };

  try {
    await app.start();
    const reply = await new Promise<{ type: string; workId?: string }>((resolveReply) => {
      void app.command({ type: "send", text: "race" }, (message) => resolveReply(message));
    });
    assert.equal(reply.type, "selected");
    await body(details);
    // The failure is a detail: the work ends well and nothing blocks it.
    const work = app.snapshot().works[0];
    assert.ok(work);
    assert.equal(work.busy, false);
    assert.equal(work.problem, undefined);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS;
    delete process.env[key];
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * The sentence the user reads before the technical detail: the part of each
 * notice up to the first colon. That is where wording matters; after it comes
 * the path or the error, which is allowed to name internals.
 */
function notices(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("No pude") || line.startsWith("No terminé"))
    .map((line) => line.split(":")[0])
    .join("\n");
}

test("App records a failed disable in work.details without blocking work", async () => {
  await withBrokenSkill("BITACORA_FAKE_SKILL_WRITE_FAIL", async (details) => {
    const text = await details();
    assert.match(text, /No pude desactivar un complemento que no es del kit:/);
    assert.doesNotMatch(notices(text), /\bskills?\b|\bentorno\b|\bmotor\b/i);
  });
});

test("App records a disable that only claimed to work, because the list is asked again", async () => {
  // The write answers `effectiveEnabled: true` for what was asked and changes
  // nothing: only a new list can tell that the skill is still on.
  await withBrokenSkill("BITACORA_FAKE_SKILL_KEEP_ENABLED", async (details) => {
    const text = await details();
    assert.match(text, /No pude desactivar un complemento que no es del kit:/);
    // The words the user sees name what happened, never the internals.
    assert.doesNotMatch(notices(text), /\bskills?\b|\bentorno\b|\bmotor\b/i);
  });
});

test("App keeps working and says so when the skills list fails", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-list-fail-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const data = join(dir, "data");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  process.env.BITACORA_FAKE_SKILLS_LIST_FAIL = "1";

  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const app = new App(engine, data, () => {});

  try {
    await app.start();
    const reply = await new Promise<{ type: string; workId?: string }>((resolveReply) => {
      void app.command({ type: "send", text: "race" }, (message) => resolveReply(message));
    });
    assert.equal(reply.type, "selected");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const work = app.snapshot().works[0];
      if (work && !work.busy) break;
      await delay(25);
    }
    const work = app.snapshot().works[0];
    assert.ok(work);
    assert.equal(work.busy, false);
    assert.equal(work.problem, undefined);
    assert.match(work.details, /No pude revisar los complementos del kit/);
    assert.doesNotMatch(notices(work.details), /\bskills?\b|\bentorno\b|\bmotor\b/i);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS_LIST_FAIL;
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CodexEngine turns off a skill that appeared since the last turn before sending", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-before-turn-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const skillsFile = join(dir, "skills.json");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(skillsFile, JSON.stringify([]), "utf8");
  process.env.BITACORA_FAKE_SKILLS_FILE = skillsFile;
  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const readSkills = async () =>
    JSON.parse(await readFile(skillsFile, "utf8")) as Array<{ name: string; enabled: boolean }>;
  try {
    await engine.start();
    const { conversationId } = await engine.createWork();
    // No notification this time: the next turn must not see the new skill.
    await writeFile(
      skillsFile,
      JSON.stringify([
        { name: "late-skill", description: "Appeared after the last turn", path: join(home, "skills", "late-skill", "SKILL.md"), scope: "user", enabled: true },
      ]),
      "utf8",
    );
    await engine.send(conversationId, "race");
    const after = await readSkills();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.enabled, false);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS_FILE;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("App is available as soon as the protection is ready, even with a slow skill list", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/slow-skills-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const data = join(dir, "data");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // The check takes longer than the whole startup: the app must be usable while
  // it runs, or the user reads "Bitácora está detenida" with a ready engine.
  process.env.BITACORA_FAKE_SKILLS_DELAY = "1500";
  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const app = new App(engine, data, () => {});
  let reply: { type: string; text?: string } | undefined;
  try {
    const starting = app.start();
    await until(() => app.snapshot().engine.safety.allowed, 10_000);
    assert.equal(
      app.snapshot().engine.available,
      true,
      "the app must not show a ready engine as stopped",
    );
    await app.command({ type: "send", text: "race" }, (message) => {
      reply = message as { type: string; text?: string };
    });
    assert.equal(reply?.type, "selected");
    assert.doesNotMatch(reply?.text ?? "", /detenid/i);
    await starting;
    await until(() => app.snapshot().works[0]?.busy === false, 15_000);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS_DELAY;
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a skill check that never answers stops at its own limit and says so", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-hang-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  process.env.BITACORA_FAKE_SKILLS_HANG = "1";
  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
    skillsSyncTimeoutMs: 150,
  });
  const details: string[] = [];
  const off = engine.subscribe((event) => {
    if (event.type === "detail") details.push(event.text);
  });
  try {
    await engine.start();
    // Without the limit the check would wait for the request timeout and say
    // something else: only the limit produces this sentence.
    await until(() =>
      details.some((text) => text.includes("No terminé de revisar los complementos a tiempo")),
    );
    assert.equal(engine.executionSafety().allowed, true);
  } finally {
    off();
    delete process.env.BITACORA_FAKE_SKILLS_HANG;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

for (const verify of ["fail", "hang", "shape"] as const) {
  test(`a batch that cannot be verified is reported with what was written (${verify})`, async () => {
    await mkdir(".local", { recursive: true });
    const dir = await mkdtemp(resolve(`.local/skills-verify-${verify}-`));
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const skillPath = join(home, "skills", "external-skill", "SKILL.md");
    process.env.BITACORA_FAKE_SKILLS = JSON.stringify([
      { name: "external-skill", description: "Not from the kit", path: skillPath, scope: "user", enabled: true },
    ]);
    process.env.BITACORA_FAKE_SKILLS_VERIFY = verify;
    const engine = new CodexEngine({
      home,
      workspace,
      binary: process.execPath,
      args: fakeAppServerArgs,
      restartDelayMs: 30,
      probeProtection: async () => false,
      skillsSyncTimeoutMs: 400,
    });
    const details: string[] = [];
    const off = engine.subscribe((event) => {
      if (event.type === "detail") details.push(event.text);
    });
    try {
      await engine.start();
      await until(() =>
        details.some((text) => text.includes("No pude comprobar si quedaron desactivados los complementos")),
      );
      const message = details.find((text) =>
        text.includes("No pude comprobar si quedaron desactivados los complementos"),
      );
      assert.match(message ?? "", /external-skill/, "the notice names what was written");
      const timedOut = details.some((text) =>
        text.includes("No terminé de revisar los complementos a tiempo"),
      );
      // Only the one that never answers runs out of time.
      assert.equal(timedOut, verify === "hang");
    } finally {
      off();
      delete process.env.BITACORA_FAKE_SKILLS;
      delete process.env.BITACORA_FAKE_SKILLS_VERIFY;
      await engine.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}

test("a pause asked while the turn is prepared does not arm its deadline early", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-pause-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // The pause deadline is shorter than the skill check: a deadline that starts
  // counting with the pause instead of with the turn would kill the engine on
  // the way, before the turn is even sent.
  process.env.BITACORA_FAKE_SKILLS_DELAY = "400";
  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
    pauseTimeoutMs: 100,
  });
  const events: Array<{ type: string; status?: string }> = [];
  const off = engine.subscribe((event) => events.push(event as { type: string; status?: string }));
  try {
    await engine.start();
    const { conversationId } = await engine.createWork();
    const sending = engine.send(conversationId, "race");
    await delay(50);
    await engine.interrupt(conversationId);
    await sending;
    // The turn was sent anyway, so the request ends the way the turn ends.
    assert.equal(
      events.some((event) => event.type === "finished" && event.status === "completed"),
      true,
      "the turn was sent and completed",
    );
    assert.equal(events.some((event) => event.type === "problem"), false);
    assert.equal(engine.executionSafety().allowed, true);
  } finally {
    off();
    delete process.env.BITACORA_FAKE_SKILLS_DELAY;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a pause asked while the request is prepared still sends the turn with its notice", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/pause-notice-"));
  const home = join(dir, "home");
  const root = join(dir, "agency");
  const data = join(dir, "data");
  const log = join(dir, "protocol.jsonl");
  await mkdir(home, { recursive: true });
  const files = new WorkspaceFiles(root);
  await files.initialize();
  process.env.BITACORA_FAKE_LOG = log;
  // The skill check is slow, so the pause asked for the second request lands
  // while the engine is still preparing it, before turn/start.
  process.env.BITACORA_FAKE_SKILLS_DELAY = "400";
  // The first turn lasts long enough for the test to create a file while it
  // runs: Deshacer then has something to restore and leaves its notice.
  process.env.BITACORA_FAKE_TURN_DELAY = "600";
  const engine = new CodexEngine({
    home,
    workspace: root,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const app = new App(engine, data, () => {}, undefined, files);
  try {
    await app.start();
    const first = app.command({ type: "send", text: "slow-start" }, () => {});
    await until(() => app.snapshot().works[0]?.busy === true);
    await writeFile(join(root, "creado.txt"), "hola");
    await first;
    await until(() => app.snapshot().works[0]?.busy === false, 10_000);
    const undo = app.snapshot().undo;
    assert.ok(undo, "Deshacer has something to restore");
    await app.command({ type: "undo", id: undo.id }, () => {});

    // The second request is prepared while the engine checks the skills: the
    // pause lands before turn/start.
    const workId = app.snapshot().works[0].id;
    const second = app.command({ type: "send", text: "pause", workId }, () => {});
    await until(() => app.snapshot().works[0]?.progress === "Preparando la respuesta…");
    await app.command({ type: "interrupt", workId }, () => {});
    await second;

    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        method?: string;
        params?: { input?: Array<{ type: string; text?: string }> };
      });
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 2, "both requests reached the agent");
    const input = turns[1]?.params?.input ?? [];
    assert.equal(input[0]?.text, "pause");
    assert.equal(
      input.some((item) => item.type === "text" && /se deshicieron los cambios/.test(item.text ?? "")),
      true,
      "the notice about the reverted files went with the turn",
    );
  } finally {
    delete process.env.BITACORA_FAKE_LOG;
    delete process.env.BITACORA_FAKE_TURN_DELAY;
    delete process.env.BITACORA_FAKE_SKILLS_DELAY;
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a request that fails before its work exists does not leave its notices behind", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-pending-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const data = join(dir, "data");
  const skillsFile = join(dir, "skills.json");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const first = join(home, "skills", "first-skill", "SKILL.md");
  const second = join(home, "skills", "second-skill", "SKILL.md");
  await writeFile(
    skillsFile,
    JSON.stringify([{ name: "first-skill", description: "At startup", path: first, scope: "user", enabled: true }]),
    "utf8",
  );
  process.env.BITACORA_FAKE_SKILLS_FILE = skillsFile;
  // Neither skill can be turned off, so every list that sees one says so once.
  process.env.BITACORA_FAKE_SKILL_KEEP_ENABLED = "*";
  process.env.BITACORA_FAKE_THREAD_START_FAIL_ONCE = "1";

  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const app = new App(engine, data, () => {});
  const details: string[] = [];
  const off = engine.subscribe((event) => {
    if (event.type === "detail") details.push(event.text);
  });
  /**
   * Sends through the app and returns the reply the app selected the work with.
   * The command rejects only when the request could not be committed.
   */
  let selected: { type: string; workId?: string; text?: string } | undefined;
  const sendCommand = (text: string) =>
    app.command({ type: "send", text }, (message) => {
      selected = message as { type: string; workId?: string; text?: string };
    });

  try {
    await app.start();
    // The startup check runs in the background: wait until it saw the first
    // skill before the file changes under it.
    await until(() => details.some((text) => text.includes("first-skill")));
    // A second skill appears: the failed request is the one that sees it, so
    // its notice belongs to that request and nowhere else.
    await writeFile(
      skillsFile,
      JSON.stringify([
        { name: "first-skill", description: "At startup", path: first, scope: "user", enabled: true },
        { name: "second-skill", description: "During the failed request", path: second, scope: "user", enabled: true },
      ]),
      "utf8",
    );
    await assert.rejects(sendCommand("primer pedido"));
    assert.equal(app.snapshot().works.length, 0);

    // The text of a request is the scenario the fake app-server runs: "race"
    // answers and ends the turn in one step.
    await sendCommand("race");
    assert.equal(
      selected?.type,
      "selected",
      `${selected?.text} | ${JSON.stringify(app.snapshot().engine)}`,
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const work = app.snapshot().works[0];
      if (work && !work.busy) break;
      await delay(25);
    }
    const work = app.snapshot().works[0];
    assert.ok(work);
    assert.match(work.details, /No pude desactivar un complemento/);
    // The notice the failed request queued was never delivered, so the engine
    // has to say it again for the work that is really sent: dropping it must
    // not make the failure silent from then on.
    assert.equal(work.details.includes("first-skill"), true);
    assert.equal(
      work.details.includes("second-skill"),
      true,
      "the notice that was thrown away is said again",
    );
    assert.equal(
      work.details.split("second-skill").length - 1,
      1,
      "and said once",
    );
  } finally {
    off();
    delete process.env.BITACORA_FAKE_SKILLS_FILE;
    delete process.env.BITACORA_FAKE_SKILL_KEEP_ENABLED;
    delete process.env.BITACORA_FAKE_THREAD_START_FAIL_ONCE;
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an unexpected skills/list shape does not keep the engine from starting", async () => {
  for (const shape of ["missing", "skills"]) {
    await mkdir(".local", { recursive: true });
    const dir = await mkdtemp(resolve(`.local/skills-shape-${shape}-`));
    const home = join(dir, "home");
    const workspace = join(dir, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    process.env.BITACORA_FAKE_SKILLS_SHAPE = shape;
    const engine = new CodexEngine({
      home,
      workspace,
      binary: process.execPath,
      args: fakeAppServerArgs,
      restartDelayMs: 30,
      probeProtection: async () => false,
    });
    const details: string[] = [];
    const off = engine.subscribe((event) => {
      if (event.type === "detail") details.push(event.text);
    });
    try {
      await engine.start();
      assert.equal(engine.executionSafety().allowed, true);
      const created = await engine.createWork();
      assert.ok(created.conversationId);
      await engine.send(created.conversationId, "race");
      assert.equal(details.length, 1, shape);
      assert.match(details[0] ?? "", /No pude revisar los complementos del kit/);
    } finally {
      off();
      delete process.env.BITACORA_FAKE_SKILLS_SHAPE;
      await engine.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test("skills/list errors are reported once, not on every sync", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-entry-error-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const brokenPath = join(home, "skills", "broken", "SKILL.md");
  process.env.BITACORA_FAKE_SKILL_ERRORS = brokenPath;
  const engine = new CodexEngine({
    home,
    workspace,
    binary: process.execPath,
    args: fakeAppServerArgs,
    restartDelayMs: 30,
    probeProtection: async () => false,
  });
  const details: string[] = [];
  const off = engine.subscribe((event) => {
    if (event.type === "detail") details.push(event.text);
  });
  try {
    await engine.start();
    const created = await engine.createWork();
    await engine.send(created.conversationId, "race");
    const reported = details.filter((text) => text.includes(brokenPath));
    assert.equal(reported.length, 1);
    assert.match(reported[0] ?? "", /No pude leer un complemento/);
  } finally {
    off();
    delete process.env.BITACORA_FAKE_SKILL_ERRORS;
    await engine.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
