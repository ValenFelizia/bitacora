// Bounded native experiment: no login, model turns, admin setup or personal home.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { codexBinary } from './codex-runtime.mjs';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/issue4-permissions-'));
const home = join(base, 'home'), workspace = join(base, 'agency');
await mkdir(home); await mkdir(workspace);
const witness = join(base, 'outside.txt'); await writeFile(witness, 'OUTSIDE_WITNESS');
await writeFile(join(workspace, 'inside.txt'), 'INSIDE_WITNESS');
await writeFile(join(home, 'config.toml'), `approval_policy = "never"
default_permissions = "agencia"
cli_auth_credentials_store = "ephemeral"
[windows]
sandbox = "mxc"
[permissions.agencia]
extends = ":workspace"
[permissions.agencia.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
[permissions.agencia.network]
enabled = false
`);
const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(CODEX_|OPENAI_|ANTHROPIC_)|TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(k)) delete env[k];
env.CODEX_HOME = home;
const child = spawn(codexBinary(), ['app-server'], { cwd: workspace, env, windowsHide: true });
const records: unknown[] = []; let stderr = '', next = 0;
const pending = new Map<number, (v: any) => void>();
child.stderr.on('data', b => stderr += b);
createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); if (m.id) pending.get(m.id)?.(m); });
async function rpc(method: string, params: unknown) {
  const id = ++next;
  const result = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout')); }, 20000);
    pending.set(id, m => { clearTimeout(timer); pending.delete(id); resolve(m); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  records.push({ method, params, response: result }); return result;
}
try {
  await rpc('initialize', { clientInfo: { name: 'bitacora_issue4', version: '0.1.0' }, capabilities: { experimentalApi: false } });
  child.stdin.write('{"method":"initialized"}\n');
  await rpc('command/exec', { command: ['cmd.exe', '/d', '/c', 'echo experimental-gate'], cwd: workspace, permissionProfile: 'agencia', timeoutMs: 10000 });
} catch (e) { records.push({ error: String(e) }); }
finally { child.stdin.end(); await new Promise<void>(r => { child.once('exit', () => r()); setTimeout(() => child.kill(), 2000).unref(); }); }
// Reinitialize a fresh connection with the capability enabled, same isolated home.
const enabled = spawn(codexBinary(), ['app-server'], { cwd: workspace, env, windowsHide: true });
enabled.stderr.on('data', b => stderr += b);
createInterface({ input: enabled.stdout }).on('line', line => { const m = JSON.parse(line); if (m.id) pending.get(m.id)?.(m); });
async function experimental(method: string, params: unknown) {
  const id = ++next;
  const result = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout')); }, 20000);
    pending.set(id, m => { clearTimeout(timer); pending.delete(id); resolve(m); });
    enabled.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }); records.push({ method, params, response: result }); return result;
}
try {
  await experimental('initialize', { clientInfo: { name: 'bitacora_issue4', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  enabled.stdin.write('{"method":"initialized"}\n');
  await experimental('permissionProfile/list', { cwd: workspace });
  await experimental('windowsSandbox/readiness', {});
  const powershell = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  for (const script of [`Write-Output SIMPLE_OK`, `Get-Content -LiteralPath ${quote(join(workspace, 'inside.txt'))} -ErrorAction Stop`, `Get-Content -LiteralPath ${quote(witness)} -ErrorAction Stop`]) {
    await experimental('command/exec', { command: [powershell, '-NoProfile', '-NonInteractive', '-Command', script], cwd: workspace, permissionProfile: 'agencia', timeoutMs: 10000 });
  }
} catch (e) { records.push({ error: String(e) }); }
finally {
  enabled.stdin.end(); await new Promise<void>(r => { enabled.once('exit', () => r()); setTimeout(() => enabled.kill(), 2000).unref(); });
  await mkdir('docs/verification/issue4', { recursive: true });
  await writeFile('docs/verification/issue4/permissions.json', JSON.stringify({ version: execFileSync(codexBinary(), ['--version'], { encoding: 'utf8' }).trim(), modelTurns: 0, records, stderr }, null, 2));
  await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
console.log('Evidence: docs/verification/issue4/permissions.json');
