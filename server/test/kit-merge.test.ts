import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { AgencyFiles } from '../src/tools/paths';
import { controlar } from '../src/tools/check';
import { WorkspaceFiles } from '../src/workspace-files';
import { verifyKitIntegration } from './kit-integration';

test('merged app, attachments, MCP tools and request results work end to end', { timeout: 240000 }, async()=>{
  assert.deepEqual((await verifyKitIntegration()).results.sort(),['pieza-1.png','piezas.pdf','todas.png']);
});
test('markdown boundaries and all supported result formats exclude operator inputs and kit artifacts', async()=>{
  const base=join(process.env.LOCALAPPDATA!,'Bitacora-dev/issue6');await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'extensiones ñ ')), files=new AgencyFiles(root);
  for(const source of ['source.html','source.js','source.png']) await assert.rejects(controlar(files,{html:'unused.html',source,report:'report.md'}),/terminación .md/);
  for(const report of ['report.html','report.js','report.exe','report.pdf']) await assert.rejects(controlar(files,{html:'unused.html',source:'source.md',report}),/terminación .md/);
  const results=new WorkspaceFiles(root);const before=await results.scan();
  for(const ext of ['png','jpg','jpeg','webp','pdf']) await files.write(`salida/pieza.${ext}`,'result');
  for(const path of ['oferta/fotos/operador/input.png','ejemplo/salida/demo.png','.kit-guard-input.png','.kit-temp.tmp']) await files.write(path,'input');
  const after=await results.scan(before);assert.equal(after.warnings.length,0);
  assert.deepEqual(Object.keys(after.entries).map(p=>p.replaceAll('\\','/')).sort(),['salida/pieza.jpeg','salida/pieza.jpg','salida/pieza.pdf','salida/pieza.png','salida/pieza.webp']);
  await files.write('salida/pieza.jpg','modified result',false);
  assert.notEqual((await results.scan(after)).entries[join('salida','pieza.jpg')].hash,after.entries[join('salida','pieza.jpg')].hash);
});
