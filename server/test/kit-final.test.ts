import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, rename, symlink, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { AgencyFiles } from '../src/tools/paths';
import { extractUserUrls, rememberUserUrls, requireAllowedUrl, allowedUrlsPath } from '../src/allowed-urls';
import { initializeKit } from '../src/tools/kit';
import { controlar } from '../src/tools/check';
import { paths, preparePaths } from '../src/paths';

async function fixture() {
  const base = join(process.env.LOCALAPPDATA!,'Bitacora-dev/issue6');
  await mkdir(base,{recursive:true});
  const dir = await mkdtemp(join(base,'final ñ '));
  const root=join(dir,'agencia'), data=join(dir,'datos');
  await mkdir(root); await mkdir(data);
  return {dir,root,data,files:new AgencyFiles(root),close:()=>rm(dir,{recursive:true,force:true})};
}
test('write race cannot replace parent before directory creation or temp open; failed temps are removed', async () => {
  const f = await fixture();
  try {
    for (const stage of ['beforeDirectoryCreate','beforeTempOpen'] as const) {
      const parent=join(f.root,stage), moved=join(f.root,stage+'-moved');
      const outside=join(f.data,stage);
      await mkdir(parent); await mkdir(outside);
      let injected = false;
      const files = new AgencyFiles(f.root,async actual => {
        if (actual !== stage || injected) return;
        injected = true;
        // A genuine substitution attempt after validation and before mutation.
        // Without directory handles this succeeds and the next mkdir/open leaks.
        try { await rename(parent,moved); await symlink(outside,parent,'junction'); }
        catch(e) { assert.match((e as NodeJS.ErrnoException).code || '',/EBUSY|EPERM|EACCES/); throw new Error('Race blocked by Windows'); }
      });
      await assert.rejects(files.write(`${stage}/${stage === 'beforeDirectoryCreate' ? 'child/' : ''}result.txt`,'secret'));
      assert.ok(injected);
      assert.deepEqual(await readdir(outside),[], 'No external directory or empty temp may be created');
      assert.deepEqual(await readdir(parent),[], 'No guard or temp may remain after failure');
    }
    for (const stage of ['afterTempOpen','afterTempWrite'] as const) {
      const files = new AgencyFiles(f.root,async actual => {if(actual===stage) throw new Error('Injected write failure');});
      await assert.rejects(files.write('cleanup/result.txt','secret'),/Injected/);
      assert.deepEqual(await readdir(join(f.root,'cleanup')),[]);
    }
  } finally { await f.close(); }
});
test('production server declares its MCP runtime dependencies', async () => {
  const root=JSON.parse(await readFile('package.json','utf8'));
  const server=JSON.parse(await readFile('server/package.json','utf8'));
  const require=createRequire(join(process.cwd(),'server/package.json'));
  for (const dep of ['tsx','playwright-core','@modelcontextprotocol/sdk','koffi']) {
    assert.ok(server.dependencies[dep],`${dep} must be a production server dependency`);
    assert.ok(!root.devDependencies[dep],`${dep} must not depend on root development installation`);
    assert.ok(require.resolve(dep === '@modelcontextprotocol/sdk' ? `${dep}/server/mcp.js` : dep));
  }
});
test('URL extraction handles quotes, balanced parentheses and no scheme without broadening authorization', async () => {
  const f=await fixture();
  try {
    const text='«https://hotel.com/a» “https://hotel.com/b” ‘https://hotel.com/c’ (https://hotel.com/a_(b)). www.hotel.com/oferta';
    const urls=['https://hotel.com/a','https://hotel.com/b','https://hotel.com/c','https://hotel.com/a_(b)','https://www.hotel.com/oferta'];
    assert.deepEqual(extractUserUrls(text),urls);
    await rememberUserUrls(f.data,text);
    for(const url of urls) await requireAllowedUrl(allowedUrlsPath(f.data),url);
    await assert.rejects(requireAllowedUrl(allowedUrlsPath(f.data),'https://hotel.com/a_(b)?secret=1'));
    await assert.rejects(requireAllowedUrl(allowedUrlsPath(f.data),'http://www.hotel.com/oferta'));
  } finally {await f.close();}
});
test('corrupt allowed list fails closed until the app quarantines it and records fresh user URLs', async () => {
  const f=await fixture();
  try {
    const path=allowedUrlsPath(f.data);
    await writeFile(path,'damaged JSON');
    await assert.rejects(requireAllowedUrl(path,'https://hotel.com/'));
    await rememberUserUrls(f.data,'Sin links todavía');
    await assert.rejects(requireAllowedUrl(path,'https://hotel.com/'),/usuaria/);
    const archive=(await readdir(f.data)).find(name=>name.startsWith('allowed-urls.json.corrupt-'))!;
    assert.equal(await readFile(join(f.data,archive),'utf8'),'damaged JSON');
    await rememberUserUrls(f.data,'www.hotel.com/oferta');
    await requireAllowedUrl(path,'https://www.hotel.com/oferta');
  } finally {await f.close();}
});
test('real data/agency aliases are rejected before startup; marker outside agency survives complete deletion', async () => {
  const f=await fixture();
  try {
    await symlink(f.root,join(f.dir,'alias'),'junction');
    const unsafe=paths({BITACORA_WORKSPACE:f.root,BITACORA_DATA_DIR:join(f.dir,'alias','data')});
    await assert.rejects(preparePaths(unsafe),/separados/);
    assert.deepEqual(await readdir(f.root),[]);
    const safe=await preparePaths(paths({BITACORA_WORKSPACE:f.root,BITACORA_DATA_DIR:f.data}));
    await initializeKit(safe.workspace,safe.data);
    assert.ok((await readdir(f.data)).some(n=>n.startsWith('kit-initialized-')));
    for(const file of await readdir(f.root)) await rm(join(f.root,file),{recursive:true,force:true});
    await initializeKit(safe.workspace,safe.data);
    assert.deepEqual(await readdir(f.root),[]);
  } finally {await f.close();}
});
test('reject uninspectable list/head/page content; count Unicode digits; operator pseudo and format characters', async () => {
  const f=await fixture();
  try {
    await f.files.write('source.md','Precio 999');
    await f.files.write('rules.json',JSON.stringify({operatorNames:['Viajes Foo']}));
    const bodies=[
      '<style>li{list-style-type:"999"}</style><ul><li>texto</li></ul>',
      '<style>@counter-style cash{system:fixed;symbols:"999"}li{list-style-type:cash}</style><li>texto</li>',
      '<style>head,title{display:block}</style><title>999</title>',
      '<style>@page{@top-center{content:"999"}}</style><p>texto</p>',
      '<style>@media print{head{display:block}}</style><p>texto</p>',
    ];
    for(const [i,body] of bodies.entries()) {
      await f.files.write(`unsupported-${i}.html`,`<!doctype html><meta charset="utf-8">${body}`);
      await assert.rejects(controlar(f.files,{html:`unsupported-${i}.html`,source:'source.md',report:'report.md'}),/Sacá/);
    }
    await f.files.write('digits.html',`<!doctype html><meta charset="utf-8"><p>９９９</p>`);
    const missing=await controlar(f.files,{html:'digits.html',source:'source.md',report:'report.md'});
    assert.equal(missing.checked,1); assert.equal(missing.ok,false);
    await f.files.write('cited.html',`<!doctype html><meta charset="utf-8"><p data-cites='{"９９９":1}'>９９９</p>`);
    assert.equal((await controlar(f.files,{html:'cited.html',source:'source.md',report:'report.md'})).ok,true);
    for(const [i,body] of ['<style>p:before{content:"Viajes Foo"}</style><p>Texto</p>','<p>Viajes&#8203;Foo</p>'].entries()) {
      await f.files.write(`operator-${i}.html`,`<!doctype html><meta charset="utf-8">${body}`);
      const result=await controlar(f.files,{html:`operator-${i}.html`,source:'source.md',report:'report.md',rules:'rules.json'});
      assert.ok(result.errors.some(e=>e.includes('operador')));
    }
  } finally {await f.close();}
});
