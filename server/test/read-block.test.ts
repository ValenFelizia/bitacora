// Real Codex app-server, real Windows sandbox, no inference and no login.
// The workspace lives under the system temp folder, outside any git repository:
// Codex reads AGENTS.md from the repository root, and a repository above the
// agency folder would be a different setup than the one this test covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexEngine, PERMISSIONS_PROFILE, PROFILE_ARGS } from "../src/codex/engine";
import { codexBinary } from "../../scripts/codex-runtime.mjs";

const windowsOnly = process.platform !== "win32";

async function sandboxBase(name: string) {
  await mkdir(".local", { recursive: true });
  const base = await mkdtemp(join(tmpdir(), `bitacora-${name}-`));
  const workspace = join(base, "agencia");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(base, "codex"), { recursive: true });
  await writeFile(join(workspace, "inside.txt"), "INSIDE_WITNESS");
  await writeFile(join(base, "outside.txt"), "OUTSIDE_WITNESS");
  return { base, workspace };
}

async function until(predicate: () => boolean, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("the real app-server starts the work with the read-restricting profile", { skip: windowsOnly }, async (t) => {
  const { base, workspace } = await sandboxBase("profile");
  const engine = new CodexEngine({
    home: join(base, "codex"),
    workspace,
    requestTimeoutMs: 60000,
  });
  try {
    await engine.start();
    // A machine that still needs the Windows setup cannot run this test: the
    // app is expected to ask for it, not to work with less protection.
    if (engine.executionSafety().needsPermission) {
      t.skip(`Windows sandbox needs the setup on this machine: ${engine.executionSafety().detail}`);
      return;
    }
    // Without a saved sandbox mode the engine probes MXC and prepares it on its
    // own; the profile is only accepted once that finished.
    assert.ok(await until(() => engine.executionSafety().allowed), engine.executionSafety().detail);
    const safety = engine.executionSafety();
    assert.match(safety.detail, new RegExp(`permissions=${PERMISSIONS_PROFILE}`));
    const work = await engine.createWork();
    assert.ok(work.conversationId);
  } finally {
    await engine.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

// The app accepts two sandbox backends, so both are checked. A backend this
// machine cannot run is skipped with the reason instead of passing silently.
for (const backend of ["mxc", "elevated"] as const) {
test(`the ${backend} backend blocks a witness file outside the agency folder and keeps the inside readable`, { skip: windowsOnly }, async (t) => {
  const { base, workspace } = await sandboxBase(`sandbox-${backend}`);
  const child = spawn(codexBinary(), ["-c", `windows.sandbox=${backend}`, ...PROFILE_ARGS, "app-server"], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: join(base, "codex") },
    windowsHide: true,
  });
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  let next = 0;
  let exited = false;
  let stderr = "";
  child.on("exit", () => (exited = true));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const id = ++next;
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}. ${stderr.slice(-2000)}`)), 60000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result as T;
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (script: string) =>
    rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
      command: [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
      cwd: workspace,
      permissionProfile: PERMISSIONS_PROFILE,
      timeoutMs: 30000,
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "bitacora_test", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const readiness = await rpc<{ status: string }>("windowsSandbox/readiness", {});
    if (readiness.status !== "ready") {
      t.skip(`the ${backend} sandbox is not ready on this machine: ${readiness.status}`);
      return;
    }
    const profiles = await rpc<{ data: { id: string; allowed: boolean }[] }>("permissionProfile/list", { cwd: workspace });
    assert.equal(profiles.data.find((profile) => profile.id === PERMISSIONS_PROFILE)?.allowed, true);

    let inside: { exitCode: number; stdout: string; stderr: string };
    try {
      inside = await run(`Get-Content -LiteralPath ${quote(join(workspace, "inside.txt"))} -ErrorAction Stop`);
    } catch (error) {
      // The elevated backend refuses a profile that denies `:root` read, so the
      // app reports that it cannot apply the profile instead of running. That
      // is a backend limit, not a regression: the engine test covers the
      // refusal itself.
      if (/requires effective `:root` read access/.test(String(error))) {
        t.skip(`the ${backend} sandbox cannot run the ${PERMISSIONS_PROFILE} profile: ${String(error)}`);
        return;
      }
      throw error;
    }
    assert.equal(inside.exitCode, 0);
    assert.match(inside.stdout, /INSIDE_WITNESS/);

    const outside = await run(`Get-Content -LiteralPath ${quote(join(base, "outside.txt"))} -ErrorAction Stop`);
    assert.notEqual(outside.exitCode, 0);
    assert.doesNotMatch(outside.stdout, /OUTSIDE_WITNESS/);
    assert.match(outside.stderr, /denied|denegado/i);

    // Writing inside the agency folder is still allowed: the profile replaced
    // the old writable-roots policy and must not turn the folder read-only.
    const write = await run(`Set-Content -LiteralPath ${quote(join(workspace, "escrito.txt"))} -Value ADENTRO`);
    assert.equal(write.exitCode, 0);
    const written = await run(`Get-Content -LiteralPath ${quote(join(workspace, "escrito.txt"))} -ErrorAction Stop`);
    assert.equal(written.exitCode, 0);
    assert.match(written.stdout, /ADENTRO/);
  } finally {
    child.stdin.end();
    if (!exited)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => child.kill(), 3000).unref();
      });
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
}
