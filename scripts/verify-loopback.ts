// No login or model turns. Fresh MXC home, same policy as production turns.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { CodexEngine } from '../server/src/codex/engine';
import { codexBinary } from './codex-runtime.mjs';
import { execFileSync } from 'node:child_process';
const base = resolve('.local/issue16-loopback');
const output = resolve('docs/verification/issue16');
await mkdir(output, {recursive:true});
const workspace = join(base, 'workspace');
const engine = new CodexEngine({home:join(base,'codex'), workspace});
const listeners = [createServer(s => { s.on('error',()=>{}); s.end('LOOPBACK_OK'); }), createServer(s => { s.on('error',()=>{}); s.end('LOOPBACK_OK'); })];
const accepted = [0,0];
listeners.forEach((s,i) => s.on('connection', () => accepted[i]++));
const records: unknown[] = [];
try {
  await new Promise<void>(r => listeners[0].listen(0,'127.0.0.1',r));
  const port = (listeners[0].address() as any).port;
  await new Promise<void>(r => listeners[1].listen(port,'::1',r));
  for (const host of ['127.0.0.1','localhost','::1']) await new Promise<void>((resolve,reject) => { const c=createConnection({host,port},()=>{c.destroy();resolve();}); c.on('error',reject); });
  accepted.fill(0);
  await engine.start();
  for(let i=0;i<200 && !engine.executionSafety().allowed;i++) await new Promise(r=>setTimeout(r,100));
  if(!engine.executionSafety().allowed) throw Error(JSON.stringify(engine.executionSafety()));
  const rpc = (method:string,params:unknown) => (engine as any).rpc(method,params);
  const config = await rpc('config/read',{includeLayers:false});
  if(config.config.windows.sandbox !== 'mxc') throw Error('MXC required');
  const policy = {type:'workspaceWrite',writableRoots:[workspace],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  for(const host of ['127.0.0.1','localhost','::1']) {
    const script = `$ErrorActionPreference='Stop'; $c=New-Object System.Net.Sockets.TcpClient${host === '::1' ? ' -ArgumentList ([System.Net.Sockets.AddressFamily]::InterNetworkV6)' : ''}; try { $t=$c.ConnectAsync('${host}',${port}); if(-not $t.Wait(4000)){throw 'TIMEOUT'}; $t.GetAwaiter().GetResult(); $r=New-Object System.IO.StreamReader($c.GetStream()); $r.ReadToEnd() } catch { $_.Exception.ToString(); exit 1 } finally { $c.Dispose() }`;
    const params = {command:['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-NonInteractive','-Command',script],cwd:workspace,sandboxPolicy:policy,timeoutMs:10000};
    const result = await rpc('command/exec',params);
    records.push({host,params,result});
  }
  await writeFile(join(output,'loopback.json'),JSON.stringify({binary:codexBinary(),version:execFileSync(codexBinary(),['--version'],{encoding:'utf8'}).trim(),windows:config.config.windows,policy,records,accepted,modelTurns:0},null,2));
  console.log(JSON.stringify({records,accepted,modelTurns:0},null,2));
} finally {
  await engine.close();
  await Promise.all(listeners.map(s=>new Promise<void>(r=>s.close(()=>r()))));
  await rm(base,{recursive:true,force:true,maxRetries:15,retryDelay:200});
}
