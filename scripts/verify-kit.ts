import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { AgencyFiles } from '../server/src/tools/paths';
import { initializeKit } from '../server/src/tools/kit';
import { BITACORA_TOOLS, registerKit } from '../server/src/codex/kit';
import { dibujar } from '../server/src/tools/draw';
import { controlar } from '../server/src/tools/check';
import { codexBinary } from './codex-runtime.mjs';

const base = join(process.env.LOCALAPPDATA!, 'Bitacora-dev', 'issue6', 'verification');
const workspace = join(base, 'agencia ñ y acentos á');
const home = join(base, 'datos/codex');
const evidence = join(process.cwd(), 'docs/verification/issue6');
await mkdir(workspace,{recursive:true}); await mkdir(home,{recursive:true}); await mkdir(evidence,{recursive:true});
let child: ReturnType<typeof spawn> | undefined;
try {
  await initializeKit(workspace,join(base,'datos')); await registerKit(home,workspace);
  const files = new AgencyFiles(workspace);
  await copyFile('C:/Windows/Fonts/arial.ttf',join(workspace,'ejemplo/local.ttf'));
  const html = (await files.read('ejemplo/pieza.html')).replace('</style>',"@font-face{font-family:Local;src:url('local.ttf')}p{font-family:Local}</style>");
  await files.write('ejemplo/local.html',html,false);
  const draw = await dibujar(files,{html:'ejemplo/local.html',destination:'salida',width:1080,height:1920});
  assert.ok(draw.ok,JSON.stringify(draw));
  for (const path of draw.files) await copyFile(await files.path(path),join(evidence,path.split('/').pop()!));
  const check = await controlar(files,{html:'ejemplo/local.html',source:'ejemplo/fuente.md',report:'control.md',rules:'ejemplo/rules.json'});
  await files.write('ejemplo/overflow.html',html.replace('</style>','p{width:10px;height:10px;overflow:hidden}</style>'),false);
  const overflow = await dibujar(files,{html:'ejemplo/overflow.html',destination:'overflow',width:1080,height:1920});
  assert.equal(overflow.ok,false);
  await files.write('ejemplo/broken.ttf','no es una fuente',false);
  await files.write('ejemplo/broken.html',html.replace("url('local.ttf')","url('broken.ttf')"),false);
  let brokenFont = '';
  try { await dibujar(files,{html:'ejemplo/broken.html',destination:'broken',width:1080,height:1920}); }
  catch(e) { brokenFont = String(e); }
  assert.match(brokenFont,/fuentes/);
  await copyFile(await files.path('control.md'),join(evidence,'control.md'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k])=> !/^(CODEX_|OPENAI_|ANTHROPIC_)|TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(k))) as NodeJS.ProcessEnv;
  env.CODEX_HOME = home;
  child = spawn(codexBinary(),['app-server','--listen','stdio://'],{env,cwd:workspace,windowsHide:true,stdio:'pipe'});
  let sequence = 0;
  const pending = new Map<number, {resolve:(x:any)=>void;reject:(x:unknown)=>void}>();
  const notifications: string[] = [];
  child.stderr!.on('data',()=>{});
  createInterface({input:child.stdout!}).on('line',line=>{
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.method) { notifications.push(msg.method); child!.stdin!.write(JSON.stringify({id:msg.id,result:{decision:'decline'}})+'\n'); return; }
    if (msg.id !== undefined) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p?.reject(msg.error); else p?.resolve(msg.result); }
  });
  async function rpc(method:string,params:unknown) {
    const id = ++sequence;
    return new Promise<any>((resolve,reject)=>{
      const timer = setTimeout(()=>{pending.delete(id);reject(new Error('Timeout: '+method));},30000);
      pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}});
      child!.stdin!.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  const initialize = await rpc('initialize',{clientInfo:{name:'bitacora-verification',version:'1.0'},capabilities:{experimentalApi:true}});
  child.stdin!.write(JSON.stringify({method:'initialized'})+'\n');
  const thread = await rpc('thread/start',{cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:true});
  const catalog = await rpc('mcpServerStatus/list',{threadId:thread.thread.id,serverName:'bitacora'});
  const server = catalog.data.find((s:any)=>s.name === 'bitacora');
  assert.ok(server,JSON.stringify(catalog));
  assert.deepEqual(Object.keys(server.tools).sort(), [...BITACORA_TOOLS].sort());
  const call = await rpc('mcpServer/tool/call',{threadId:thread.thread.id,server:'bitacora',tool:'traer',arguments:{destination:'ejemplo',notes:'Dato de prueba: 5 kg.'}});
  assert.ok(!call.isError,JSON.stringify(call));
  const calls = [call];
  for (const [tool,args] of [
    ['controlar',{html:'ejemplo/local.html',source:'ejemplo/fuente.md',report:'protocolo-control.md',rules:'ejemplo/rules.json'}],
    ['dibujar',{html:'ejemplo/local.html',destination:'protocolo-salida',width:1080,height:1920}],
  ] as const) {
    const value = await rpc('mcpServer/tool/call',{threadId:thread.thread.id,server:'bitacora',tool,arguments:args});
    assert.ok(!value.isError,JSON.stringify(value));
    calls.push(value);
  }
  assert.equal(notifications.length,0,JSON.stringify(notifications));
  await writeFile(join(evidence,'protocol.json'),JSON.stringify({initialize,tools:Object.keys(server.tools),approvalRequests:notifications,calls,draw,check,overflow,brokenFont,modelTurns:0},null,2),'utf8');
  console.log('PASS: Edge con fuente local; PNG/PDF; catálogo MCP real y llamada sin aprobaciones, cero turnos.');
} finally {
  if (child && child.exitCode === null) { const exit = new Promise(r=>child!.once('exit',r)); child.stdin!.end(); setTimeout(()=>child?.kill(),2000).unref(); await exit; }
  await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:500});
}
