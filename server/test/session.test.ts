import { WebSocket } from 'ws';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session';
import { serve } from '../src/server';
import { FakeEngine } from './fake-engine';
import { authenticate } from './session-helper';
import { mkdir, mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('entry expires, cannot be reused, and malformed secrets fail', () => {
  let now=0; const s=createSession(()=>now);
  assert.equal(s.redeem('incorrect'), undefined);
  const cookie=s.redeem(s.entryCode)!;
  assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\//);
  assert.doesNotMatch(cookie,/Expires|Max-Age|Domain/);
  assert.equal(s.redeem(s.entryCode),undefined);
  assert.equal(s.authenticated({headers:{cookie:cookie.split(';')[0]}}),true);
  for(const cookie of ['', 'bitacora_session=wrong', 'bitacora_session='+'0'.repeat(64)]) assert.equal(s.authenticated({headers:{cookie}}),false);
  const expired=createSession(()=>now); now=120000;
  assert.equal(expired.redeem(expired.entryCode),undefined);
});

test('restart invalidates cookies; bootstrap and secret never enter persisted app data or logs', async () => {
  await mkdir('.local',{recursive:true}); const dir=await mkdtemp(resolve('.local/session-'));
  const logs:string[]=[]; const log=console.log; console.log=(...args)=>logs.push(args.join(' '));
  let server:Awaited<ReturnType<typeof serve>>|undefined;
  try {
    server=await serve(new FakeEngine(),dir,0);
    const base=()=>`http://127.0.0.1:${server!.port}`;
    const code=new URL(server.entryUrl).hash.slice(1);
    assert.equal((await fetch(base()+'/entry',{method:'POST',body:code})).status,403);
    const cookie=await authenticate(server);
    assert.equal((await fetch(base()+'/entry',{method:'POST',headers:{Origin:'http://127.0.0.1:5173'},body:code})).status,403);
    assert.equal((await fetch(base()+'/session',{headers:{Cookie:cookie}})).status,204);
    assert.equal((await fetch(base()+'/files?id=x',{headers:{Origin:'http://127.0.0.1:5173'}})).status,403);
    await server.close(); server=await serve(new FakeEngine(),dir,0);
    assert.equal((await fetch(base()+'/session',{headers:{Cookie:cookie}})).status,403);
    const freshCookie=await authenticate(server);
    const ws=new WebSocket(base().replace('http:','ws:')+'/ws', {origin:'http://127.0.0.1:5173',headers:{Cookie:freshCookie}});
    await new Promise<void>((resolve,reject)=>{ ws.once('message',()=>resolve()); ws.once('error',reject); });
    const saved=new Promise<void>(resolve=>ws.on('message',data=>{const m=JSON.parse(String(data)); if(m.state?.works.length) resolve();}));
    ws.send(JSON.stringify({type:'send',text:'synthetic persistence witness'})); await saved;
    ws.terminate(); await server.close(); server=undefined;
    const works=await readFile(join(dir,'works.json'),'utf8'); assert.match(works,/synthetic persistence witness/);
    const freshSecret=freshCookie.split('=')[1];
    assert.ok(!works.includes(freshSecret));
    const secret=cookie.split('=')[1];
    for(const name of await readdir(dir)) {
      const content=await readFile(join(dir,name),'utf8');
      assert.ok(!content.includes(secret)); assert.ok(!content.includes(code));
    }
    assert.ok(!logs.join('').includes(freshSecret)); assert.ok(!logs.join('').includes(secret)); assert.ok(!logs.join('').includes(code));
  } finally { console.log=log; await server?.close(); await rm(dir,{recursive:true,force:true}); }
});
