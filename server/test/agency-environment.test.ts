// Curated agency environment tests (DEC-011): unit checks, fake-engine check,
// and real Codex binary verification without inference or login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENCY_DEVELOPER_INSTRUCTIONS,
  AGENCY_ENVIRONMENT,
} from "../src/agency-environment";
import { CodexEngine, PERMISSIONS_PROFILE, appServerArgs } from "../src/codex/engine";
import { codexEnvironmentArgs } from "../src/codex/environment";
import { registerKit } from "../src/codex/kit";
import { codexBinary } from "../../scripts/codex-runtime.mjs";
import { fakeAppServerArgs } from "./fake-app-server";

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

test("agency environment policy and developer instructions match DEC-011", () => {
  assert.equal(AGENCY_ENVIRONMENT.aiImages, true);
  assert.equal(AGENCY_ENVIRONMENT.webSearch, "disabled");
  assert.equal(AGENCY_ENVIRONMENT.subagents, false);
  assert.equal(AGENCY_ENVIRONMENT.bundledSkills, false);
  assert.equal(AGENCY_ENVIRONMENT.pluginSuggestions, false);
  assert.deepEqual(AGENCY_ENVIRONMENT.allowedPlugins, []);
  assert.deepEqual(AGENCY_ENVIRONMENT.allowedConnectors, []);

  assert.doesNotMatch(AGENCY_DEVELOPER_INSTRUCTIONS, /No generes imágenes con IA/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /castellano rioplatense/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /si la usuaria te lo pide explícitamente/i);
  assert.match(AGENCY_DEVELOPER_INSTRUCTIONS, /nunca presentes una imagen con IA.*foto real de un hotel o un destino/i);
});

test("codexEnvironmentArgs applies -c overrides cleanly and supports future allowlists", () => {
  const defaults = codexEnvironmentArgs();
  for (const backend of [undefined, "mxc", "elevated"] as const) {
    assert.equal(containsSubsequence(appServerArgs(backend), defaults), true, String(backend));
  }
  assert.equal(
    appServerArgs("elevated").some((arg) => arg.includes(PERMISSIONS_PROFILE)),
    false,
  );

  const withAllowlists = codexEnvironmentArgs({
    ...AGENCY_ENVIRONMENT,
    allowedPlugins: ["canva@openai-curated"],
    allowedConnectors: ["google_drive"],
  });
  assert.equal(containsSubsequence(withAllowlists, ["-c", "features.plugins=true"]), true);
  assert.equal(containsSubsequence(withAllowlists, ["-c", "plugins._default.enabled=false"]), true);
  assert.equal(
    containsSubsequence(withAllowlists, ["-c", 'plugins."canva@openai-curated".enabled=true']),
    true,
  );
  assert.equal(containsSubsequence(withAllowlists, ["-c", "features.apps=true"]), true);
  assert.equal(containsSubsequence(withAllowlists, ["-c", "include_apps_instructions=true"]), true);
  assert.equal(containsSubsequence(withAllowlists, ["-c", "apps._default.enabled=false"]), true);
  assert.equal(
    containsSubsequence(withAllowlists, ["-c", 'apps."google_drive".enabled=true']),
    true,
  );
  assert.equal(containsSubsequence(withAllowlists, ["-c", "features.tool_suggest=false"]), true);
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

test("real codex features list enforces DEC-011 and catches newly enabled defaults", async () => {
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

    for (const off of [
      "plugins",
      "remote_plugin",
      "plugin_discovery_prefetch",
      "plugin_sharing",
      "tool_suggest",
      "apps",
      "multi_agent",
      "multi_agent_v2",
    ]) {
      assert.equal(features.get(off), false, `expected feature ${off} to be false`);
    }

    // Drift guard: fail if a Codex upgrade adds a new enabled plugin, app,
    // subagent, or web search feature flag by default.
    for (const [name, enabled] of features) {
      if (!enabled) continue;
      assert.doesNotMatch(
        name,
        /^(plugins?|remote_plugin|plugin_.*|tool_suggest|apps|multi_agent.*|subagent.*|web_search.*)$/i,
        `unexpected curated-off feature enabled: ${name}`,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("real codex app-server enforces DEC-011 without inference, keeps bitacora MCP healthy, and skips catalogue clone", async () => {
  const base = await mkdtemp(join(tmpdir(), "bitacora-appserver-env-"));
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await registerKit(home, workspace);

  const child = spawn(codexBinary(), appServerArgs("mxc"), {
    cwd: workspace,
    env: isolatedCodexEnv(home),
    windowsHide: true,
    stdio: "pipe",
  });
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  let nextId = 0;
  let exited = false;
  let stderr = "";
  child.on("exit", () => {
    exited = true;
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const id = ++nextId;
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`RPC timeout: ${method}. ${stderr.slice(-2000)}`)),
        30000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result as T;
  };

  try {
    await rpc("initialize", {
      clientInfo: { name: "bitacora_env_test", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write('{"method":"initialized"}\n');

    const { config } = await rpc<{
      config: {
        web_search: string | null;
        include_apps_instructions?: boolean;
        features?: Record<string, boolean | null>;
        plugins?: Record<string, { enabled?: boolean }>;
        apps?: Record<string, { enabled?: boolean }>;
        agents?: { enabled?: boolean };
        skills?: { bundled?: { enabled?: boolean } };
      };
    }>("config/read", { includeLayers: false });

    assert.equal(config.web_search, "disabled");
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
    assert.equal(config.plugins?._default?.enabled, false);
    assert.equal(config.apps?._default?.enabled, false);
    assert.equal(config.agents?.enabled, false);
    assert.equal(config.skills?.bundled?.enabled, false);

    const skills = await rpc<{
      data: Array<{ skills: Array<{ name: string; scope: string; enabled: boolean }> }>;
    }>("skills/list", { cwds: [workspace], forceReload: true });
    const systemSkills = skills.data.flatMap((entry) => entry.skills).filter((skill) => skill.scope === "system");
    assert.deepEqual(systemSkills, []);

    const mcp = await rpc<{
      data: Array<{ name: string; toolsError: unknown; tools: Record<string, unknown> }>;
    }>("mcpServerStatus/list", {});
    const bitacora = mcp.data.find((server) => server.name === "bitacora");
    assert.ok(bitacora, "bitacora MCP server missing");
    assert.equal(bitacora.toolsError, null);
    assert.deepEqual(Object.keys(bitacora.tools).sort(), ["controlar", "dibujar", "traer"]);

    // Give any would-be background startup sync a moment before checking disk.
    await delay(500);
    assert.equal(existsSync(join(home, ".tmp", "plugins")), false);
    assert.equal(existsSync(join(home, "skills", ".system")), false);

    // Overrides live on the command line only, never written to config.toml.
    const configToml = await readFile(join(home, "config.toml"), "utf8");
    assert.doesNotMatch(configToml, /web_search|image_generation|multi_agent|tool_suggest|bundled/i);
  } finally {
    child.stdin.end();
    if (!exited) {
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(() => child.kill(), 3000).unref();
      });
    }
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
