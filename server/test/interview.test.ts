import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgencyFiles } from '../src/tools/paths';
import { initializeKit } from '../src/tools/kit';
import { controlar } from '../src/tools/check';
import { withPage } from '../src/tools/page';
import { App } from '../src/app';
import { FakeEngine } from './fake-engine';
import { WorkspaceFiles } from '../src/workspace-files';

async function fixture() {
  await mkdir('.local',{recursive:true});
  const temp = await mkdtemp(resolve('.local/interview-'));
  const root=join(temp,'agencia'),data=join(temp,'datos');
  await mkdir(root);await initializeKit(root,data);
  return {temp,root,data,files:new AgencyFiles(root)};
}
test('brand citations keep full tokens, normalization, line and path boundaries',{ timeout: 180000 },async()=>{
  const f=await fixture();
  try {
    await f.files.write('marca/datos.md','WhatsApp: 3513087144\nLegajo: 12345\nNúmero: 1.250\n');
    const input={html:'pieza.html',source:'ejemplo/fuente.md',brand:'marca/datos.md',report:'control.md'};
    const html=(number:string,line:number|string)=>`<!doctype html><meta charset="utf-8"><body><p data-cites='${JSON.stringify({[number]:line})}'>${number}</p></body>`;
    for(const [number,line,ok] of [['3513087144','m:1',true],['12345','m:2',true],['1250','m:3',true],['１２３４５','m:2',true],['1234','m:2',false],['3513087144',1,false],['12345','m:1',false],['12345','m:0',false],['12345','m:-1',false],['12345','m:2.0',false],['12345','m:02',false],['12345','m:99',false],['12345','2',false],['7',3,true]] as const) {
      await f.files.write(input.html,html(number,line),false);
      assert.equal((await controlar(f.files,input)).ok,ok,`${number}:${line}`);
    }
    await f.files.write(input.html,html('12345','m:2'),false);
    assert.equal((await controlar(f.files,{...input,brand:undefined})).ok,false);
    assert.match(await f.files.read(input.report),/parámetro brand/);
    await controlar(f.files,input);
    assert.match(await f.files.read(input.report),/marca\/datos.md \| m:2 \| Legajo: 12345/);
    await assert.rejects(controlar(f.files,{...input,report:input.brand}),/entrada/);
    await assert.rejects(controlar(f.files,{...input,brand:'../fuera.md'}));
    await assert.rejects(controlar(f.files,{...input,brand:'marca/datos.json'}),/terminación/);
  } finally { await rm(f.temp,{recursive:true,force:true}); }
});
test('kit copies font bytes exactly, preserves edits and loads all six families in Edge',{ timeout: 180000 },async()=>{
  const f=await fixture();
  try {
    const manifest=JSON.parse(await f.files.read('fuentes/procedencia.json'));
    assert.ok(manifest.totalBytes<3000000);
    for(const font of manifest.archivos) {
      assert.deepEqual(await f.files.readBuffer(`fuentes/${font.archivo}`),await readFile(`kit/turismo/fuentes/${font.archivo}`));
    }
    await f.files.write('fuentes/README.md','Edición propia',false);
    await initializeKit(f.root,f.data);
    assert.equal(await f.files.read('fuentes/README.md'),'Edición propia');
    const names=['Lora','Fraunces','Manrope','Source Sans 3','Outfit','Caveat'];
    await f.files.write('letras.html',`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fuentes/fuentes.css"><body>${names.map(name=>`<p style='font:600 42px "${name}"'>áéíóúüñ ÁÉÍÓÚÜÑ</p>`).join('')}</body>`);
    const loaded=await withPage(f.files,'letras.html',page=>page.evaluate(()=>Array.from(document.fonts).filter(f=>f.status==='loaded').map(f=>f.family.replaceAll('"',''))));
    for(const name of names) assert.ok(loaded.includes(name),name);
  } finally { await rm(f.temp,{recursive:true,force:true}); }
});
test('snapshot notices brand creation and removal without provider knowledge',async()=>{
  const f=await fixture(); const app=new App(new FakeEngine(),f.data,()=>{},undefined,new WorkspaceFiles(f.root));
  try {
    await app.start(); assert.equal(app.snapshot().hasBrand,false);
    await mkdir(join(f.root,'marca')); assert.equal(app.snapshot().hasBrand,true);
    await rm(join(f.root,'marca'),{recursive:true}); assert.equal(app.snapshot().hasBrand,false);
    await app.command({type:'send',text:'Ayudame a armar mi marca y mis plantillas para empezar.'},()=>{});
    assert.equal(app.snapshot().works.length,1);
    assert.equal(app.snapshot().works[0].messages[0].text,'Ayudame a armar mi marca y mis plantillas para empezar.');
  } finally { await app.close(); await rm(f.temp,{recursive:true,force:true}); }
});
