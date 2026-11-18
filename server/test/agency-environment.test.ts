// Curated agency environment tests (DEC-011): unit checks, fake-engine check,
// and real Codex binary verification without inference or login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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
  "deferred_tool_world_state",
  "enable_request_compression",
  "fast_mode",
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
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
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
  return { child, rpc, close };
}

test("agency environment policy and developer instructions match DEC-011", () => {
  assert.equal(AGENCY_ENVIRONMENT.aiImages, true);
  assert.equal(AGENCY_ENVIRONMENT.webSearch, "disabled");
  assert.equal(AGENCY_ENVIRONMENT.subagents, false);
  assert.equal(AGENCY_ENVIRONMENT.goals, false);
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
      "goals",
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
      assert.equal(config.features?.goals, false);
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
      assert.deepEqual(details, []);
      assert.equal(process.env.HOME, beforeHome);
      assert.equal(process.env.USERPROFILE, beforeUserProfile);
    } finally {
      unsubscribe();
      await engine.close();
    }

    // Verify with a fresh app-server reading the same CODEX_HOME and workspace
    // that the synthetic user/repo skills and any host skills discovered on
    // this machine were persisted as disabled.
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
      for (const skill of listed) {
        assert.equal(skill.enabled, false, `expected skill ${skill.name} (${skill.scope}) to be disabled`);
      }
    } finally {
      await verifier.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
);

test("CodexEngine re-disables newly enabled skills when skills/changed arrives", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-changed-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const skillsFile = join(dir, "skills.json");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    skillsFile,
    JSON.stringify([
      {
        name: "initial-user-skill",
        description: "Initial",
        path: join(home, "skills", "initial-user-skill", "SKILL.md"),
        scope: "user",
        enabled: true,
      },
    ]),
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

  try {
    await engine.start();
    const afterStart = JSON.parse(await readFile(skillsFile, "utf8")) as Array<{ name: string; enabled: boolean }>;
    assert.equal(afterStart[0]?.enabled, false);

    await writeFile(
      skillsFile,
      JSON.stringify([
        ...afterStart,
        {
          name: "added-user-skill",
          description: "Added mid-session",
          path: join(home, "skills", "added-user-skill", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]),
      "utf8",
    );

    const { conversationId } = await engine.createWork();
    await engine.send(conversationId, "skills-changed");
    await finished;

    const deadline = Date.now() + 5000;
    let updated: Array<{ name: string; enabled: boolean }> = [];
    while (Date.now() < deadline) {
      updated = JSON.parse(await readFile(skillsFile, "utf8")) as Array<{ name: string; enabled: boolean }>;
      if (updated.every((skill) => skill.enabled === false)) break;
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

test("App records skill-disable failures in work.details without blocking work", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/skills-error-"));
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const data = join(dir, "data");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const badSkillPath = join(home, "skills", "broken-skill", "SKILL.md");
  process.env.BITACORA_FAKE_SKILLS = JSON.stringify([
    {
      name: "broken-skill",
      description: "Cannot be toggled",
      path: badSkillPath,
      scope: "user",
      enabled: true,
    },
  ]);
  process.env.BITACORA_FAKE_SKILL_WRITE_FAIL = badSkillPath;

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
    assert.match(work.details, /No pude apagar la skill "broken-skill"/);
    assert.doesNotMatch(work.details, /\bmotor\b/i);
  } finally {
    delete process.env.BITACORA_FAKE_SKILLS;
    delete process.env.BITACORA_FAKE_SKILL_WRITE_FAIL;
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
