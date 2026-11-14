import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { AgencyFiles } from '../src/tools/paths';
import { allowedUrlsPath, rememberUserUrls, readAllowedUrls, requireAllowedUrl } from '../src/allowed-urls';
import { traer, decodePage, photoExtension } from '../src/tools/fetch';
import { controlar, normalizeNumber } from '../src/tools/check';
import { dibujar } from '../src/tools/draw';
import { initializeKit } from '../src/tools/kit';
import { App } from '../src/app';
import { FakeEngine } from './fake-engine';
import { photoFixture } from './photo-fixture';

const base = join(process.env.LOCALAPPDATA!, 'Bitacora-dev/issue6');
async function fixture() {
  await mkdir(base,{recursive:true});
  const dir = await mkdtemp(join(base,'revisión ñ '));
  const root = join(dir,'agencia'), data = join(dir,'datos');
  await mkdir(root); await mkdir(data);
  return {dir,root,data,files:new AgencyFiles(root),options:{allowedUrls:allowedUrlsPath(data)},close:()=>rm(dir,{recursive:true,force:true})};
}
test('app records only accepted user URLs before sending to a provider', async () => {
  const f = await fixture();
  const engine = new FakeEngine();
  const app = new App(engine,f.data,()=>{});
  const send = engine.send.bind(engine);
  engine.send = async (id,text) => {
    assert.deepEqual(await readAllowedUrls(allowedUrlsPath(f.data)),['https://operador.example/oferta?hotel=A']);
    await send(id,text);
  };
  try {
    await app.start();
    await app.command({type:'send',text:'Prepará https://operador.example/oferta?hotel=A'},()=>{});
    engine.emit({type:'message',conversationId:'conversation-1',id:'assistant',text:'https://otro.example/?secret=1',delta:false});
    assert.deepEqual(await readAllowedUrls(allowedUrlsPath(f.data)),['https://operador.example/oferta?hotel=A']);
  } finally { await app.close(); await f.close(); }
});
test('allowed URLs are exact after URL normalization, external and read-only for tools', async () => {
  const f = await fixture();
  try {
    await rememberUserUrls(f.data,'Mirá <HTTPS://Operador.Example:443/oferta?hotel=A&fecha=2027#precio>.');
    const path = allowedUrlsPath(f.data);
    await requireAllowedUrl(path,'https://operador.example/oferta?hotel=A&fecha=2027');
    for (const url of ['http://operador.example/oferta?hotel=A&fecha=2027','https://operador.example:444/oferta?hotel=A&fecha=2027','https://otro.example/oferta?hotel=A&fecha=2027','https://operador.example/otra?hotel=A&fecha=2027','https://operador.example/oferta?hotel=B&fecha=2027','https://operador.example/oferta?fecha=2027&hotel=A']) await assert.rejects(requireAllowedUrl(path,url),/usuaria/);
    await assert.rejects(f.files.write('../datos/allowed-urls.json','[]'));
    await assert.rejects(f.files.read('../datos/allowed-urls.json'));
    await assert.rejects(traer(f.files,{url:'https://operador.example/?datos=secretos',destination:'no'},f.options),/usuaria/);
    assert.equal((await readAllowedUrls(path)).length,1);
  } finally { await f.close(); }
});
test('hostname DNS pinning, Windows-1252 headers/meta, byte signatures and transfer limits', async () => {
  const f = await fixture();
  const png = photoFixture();
  const hosts: string[] = [];
  const server = createServer((req,res) => {
    assert.match(req.headers['user-agent'] || '',/Mozilla/);
    assert.match(req.headers.accept || '',/text\/html/);
    assert.match(req.headers.accept || '',/image\//);
    hosts.push(req.headers.host!);
    switch(req.url) {
      case '/big': res.writeHead(200,{'content-type':'text/html'}).end(Buffer.alloc(2_000_001,65)); return;
      case '/slow': return; // Aborted and explicitly closed below.
      case '/photo': res.writeHead(200,{'content-type':'image/png'}).end(png); return;
      case '/big-photo': res.writeHead(200,{'content-type':'image/png'}).end(Buffer.alloc(5_000_001)); return;
      case '/fake-photo': res.writeHead(200,{'content-type':'image/png'}).end('<html>no es foto</html>'); return;
      case '/mismatch': res.writeHead(200,{'content-type':'image/jpeg'}).end(png); return;
      case '/binary': res.writeHead(200,{'content-type':'application/octet-stream'}).end(png); return;
      case '/jpg-alias': res.writeHead(200,{'content-type':'image/jpg'}).end(png); return;
      case '/photos': res.writeHead(200,{'content-type':'text/html'}).end(Array.from({length:14},(_,i)=>`<img src="/photo?${i}">`).join('')); return;
      case '/bad-photos': res.writeHead(200,{'content-type':'text/html'}).end('<img src="/big-photo"><img src="/fake-photo"><img src="/mismatch"><img src="/binary"><img src="/jpg-alias">'); return;
      case '/redirect': res.writeHead(302,{location:'/header'}).end(); return;
      case '/loop': res.writeHead(302,{location:'/loop'}).end(); return;
    }
    if (req.url?.startsWith('/photo?')) { res.writeHead(200,{'content-type':'image/png'}).end(png); return; }
    res.writeHead(200,{'content-type':req.url === '/meta' ? 'text/html' : 'text/html; charset=windows-1252'}).end(Buffer.from('<meta charset="windows-1252"><p>Peña, habitación y avión: 7 noches</p>','latin1'));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin = `http://operador.test:${(server.address() as {port:number}).port}`;
  const resolved: string[] = [];
  const options = {...f.options,testOrigin:origin,resolve:async (host:string)=>{resolved.push(host);return [{address:'127.0.0.1',family:4}];}};
  try {
    await rememberUserUrls(f.data,['/header','/meta','/big','/slow','/photos','/bad-photos','/redirect','/loop'].map(p=>origin+p).join(' '));
    for (const suffix of ['header','meta','redirect']) {
      const r = await traer(f.files,{url:origin+'/'+suffix,destination:suffix},options);
      assert.match(await f.files.read(r.source),/Peña, habitación y avión/);
    }
    assert.ok(resolved.length >= 4 && resolved.every(h=>h==='operador.test'));
    assert.ok(hosts.every(h=>h===new URL(origin).host));
    await assert.rejects(traer(f.files,{url:origin+'/big',destination:'big'},options),/tamaño/);
    const start = Date.now();
    await assert.rejects(traer(f.files,{url:origin+'/slow',destination:'slow'},{...options,timeoutMs:100}));
    assert.ok(Date.now()-start < 3000);
    await assert.rejects(traer(f.files,{url:origin+'/header',destination:'dns-timeout'},{...options,timeoutMs:100,resolve:()=>new Promise(()=>{})}));
    const photos = await traer(f.files,{url:origin+'/photos',destination:'photos'},options);
    assert.equal(photos.photos?.length,12); assert.match(photos.warnings!.join(' '),/máximo 12/);
    const bad = await traer(f.files,{url:origin+'/bad-photos',destination:'bad'},options);
    assert.equal(bad.photos?.length,3); assert.equal(bad.warnings?.length,2);
    assert.match(bad.warnings!.join(' '),/tamaño/); assert.match(bad.warnings!.join(' '),/bytes/);
    await assert.rejects(traer(f.files,{url:origin+'/loop',destination:'loop'},options),/redirecciones/);
    assert.equal(photoExtension(png),'png');
    assert.equal(photoExtension(Buffer.from([255,216,255,224])),'jpg');
    assert.equal(photoExtension(Buffer.from('RIFF1234WEBP1234')),'webp');
    assert.throws(()=>photoExtension(Buffer.from('not an image')));
    assert.match(decodePage(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">Peña','latin1'),'text/html'),/Peña/);
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await f.close(); }
});
test('external junctions cannot read, write, or feed Edge; deleted kit files stay deleted', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.data,'outside.html'),'<p>fuera</p>');
    await symlink(f.data,join(f.root,'outside'),'junction');
    await assert.rejects(f.files.read('outside/outside.html'),/enlaces/);
    await assert.rejects(f.files.write('outside/new.txt','no'),/enlaces/);
    await assert.rejects(dibujar(f.files,{html:'outside/outside.html',destination:'salida',width:1080,height:1920}),/enlaces/);
    await assert.rejects(readFile(join(f.data,'new.txt')));
    await initializeKit(f.root,f.data);
    await rm(join(f.root,'ejemplo'),{recursive:true});
    await initializeKit(f.root,f.data);
    await assert.rejects(f.files.read('ejemplo/pieza.html'));
    await f.files.write('atomic.txt','old'); await f.files.write('atomic.txt','new',false);
    assert.equal(await f.files.read('atomic.txt'),'new');
    await assert.rejects(f.files.write('atomic.txt','overwrite'));
    assert.equal(await f.files.read('atomic.txt'),'new');
  } finally { await f.close(); }
});
test('unsupported visible constructions fail closed, including declarative shadow roots and counters', async () => {
  const f = await fixture();
  try {
    await f.files.write('source.md','7 noches');
    const cases = ['<div><template shadowrootmode="open"><p>7</p></template></div>','<iframe srcdoc="<p>7</p>"></iframe>','<object data="x"></object>','<embed src="x">','<input value="7">','<select><option>7</option></select>','<style>p:before{counter-increment:n;content:counter(n)}</style><p>texto</p>','<style>@media print{p:before{content:counters(n,".")}}</style><p>texto</p>'];
    for (const [i,body] of cases.entries()) {
      await f.files.write(`unsupported-${i}.html`,`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
      await assert.rejects(controlar(f.files,{html:`unsupported-${i}.html`,source:'source.md',report:'report.md'}),/Sacá/);
    }
  } finally { await f.close(); }
});
test('accented experience, split operator, emoji, extra citations and whole-number normalization', async () => {
  const f = await fixture();
  try {
    assert.equal(normalizeNumber('1,670'),normalizeNumber('1.670'));
    assert.equal(normalizeNumber('1.670,50'),'1670.50');
    assert.equal(normalizeNumber('1,670.50'),'1670.50');
    assert.equal(normalizeNumber('1.234.567'),'1234567');
    await f.files.write('source.md','Precio 1.670\n15 kg en 2027');
    await f.files.write('rules.json',JSON.stringify({operatorNames:['Operador'],noEmoji:true,warnExperience:true}));
    await f.files.write('check.html',`<!doctype html><meta charset="utf-8"><body><p data-cites='{"1,670":1,"99":2}'>USD 1,670</p><p>Opera<b>dor</b></p><p>Yo visité el hotel y conocí la playa. Me hospedé ahí. 🌴</p><p data-cites='{"5":2}'>5 kg</p></body>`);
    const result = await controlar(f.files,{html:'check.html',source:'source.md',report:'report.md',rules:'rules.json'});
    assert.equal(result.ok,false);
    assert.equal(result.errors.filter(e=>e.includes('1,670')).length,0);
    assert.ok(result.errors.some(e=>e.includes('operador')));
    assert.ok(result.errors.some(e=>e.includes('emojis')));
    assert.ok(result.errors.some(e=>e.includes('5 no está respaldado')));
    assert.ok(result.warnings.some(e=>e.includes('usuaria si estuvo')));
    assert.ok(result.warnings.some(e=>e.includes('sobra la cita de 99')));
  } finally { await f.close(); }
});
