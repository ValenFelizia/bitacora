import { test } from 'node:test';
import { BITACORA_TOOLS } from '../src/codex/kit';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { KIT_SKILLS } from '../src/agency-environment';
import { App } from '../src/app';
import { WorkspaceFiles } from '../src/workspace-files';
import { FakeEngine } from './fake-engine';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callKitTool, connectKitClient, listKitTools } from './mcp-client';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AgencyFiles } from '../src/tools/paths';
import { traer, publicAddress } from '../src/tools/fetch';
import { controlar } from '../src/tools/check';
import { dibujar } from '../src/tools/draw';
import { initializeKit } from '../src/tools/kit';
import { allowedUrlsPath, rememberUserUrls } from '../src/allowed-urls';
import { photoFixture } from './photo-fixture';

const base = join(process.env.LOCALAPPDATA!, 'Bitacora-dev', 'issue6');
async function fixture() {
  await mkdir(base, {recursive:true});
  const temp = await mkdtemp(join(base, 'caso ñ á '));
  const root = join(temp,'agencia'), data = join(temp,'datos');
  await mkdir(root); await mkdir(data);
  return { root, data, options:{allowedUrls:allowedUrlsPath(data)}, files: new AgencyFiles(root), close: () => rm(temp, {recursive:true, force:true}) };
}
test('path boundaries, Windows names, links and kit preservation', async () => {
  const f = await fixture();
  try {
    for (const path of ['../fuera', 'C:\\fuera', '\\fuera', 'a:stream', 'con.txt', 'archivo.']) await assert.rejects(f.files.path(path));
    await mkdir(join(f.root, 'real'));
    await symlink(join(f.root, 'real'), join(f.root, 'link'), 'junction');
    await assert.rejects(f.files.write('link/archivo', 'no'));
    await f.files.write('AGENTS.md', 'Instrucciones propias');
    await initializeKit(f.root,f.data); await initializeKit(f.root,f.data);
    assert.equal(await f.files.read('AGENTS.md'), 'Instrucciones propias');
    await assert.rejects(f.files.read('ejemplo/pieza.html'), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('the kit comes back when the agency folder is deleted', async () => {
  const f = await fixture();
  try {
    await initializeKit(f.root, f.data);
    await rm(join(f.root, 'ejemplo'), { recursive: true, force: true });
    await initializeKit(f.root, f.data);
    // A kit file the agency deleted on purpose stays deleted.
    await assert.rejects(f.files.read('ejemplo/pieza.html'), { code: 'ENOENT' });
    // The whole folder is deleted, as if the agency moved it: the next start
    // copies the kit again.
    await rm(f.root, { recursive: true, force: true });
    await initializeKit(f.root, f.data);
    assert.match(await f.files.read('AGENTS.md'), /\S/);
    assert.match(await f.files.read('ejemplo/pieza.html'), /data-cites/);
    // A kit folder that lost AGENTS.md gets the kit back without
    // overwriting the agency's own work (#65).
    await f.files.write('ejemplo/pieza.html', 'Pieza propia', false);
    await rm(join(f.root, 'AGENTS.md'));
    await initializeKit(f.root, f.data);
    assert.match(await f.files.read('AGENTS.md'), /\S/);
    assert.equal(await f.files.read('ejemplo/pieza.html'), 'Pieza propia');
    // A copy cut short after AGENTS.md is written still resumes even though
    // the original empty folder now contains some kit files.
    await rm(f.root, { recursive: true, force: true });
    const kit = join(f.data, 'test-kit');
    await mkdir(kit);
    await writeFile(join(kit, 'AGENTS.md'), 'Instrucciones del kit');
    await symlink(f.data, join(kit, 'ejemplo'), 'junction');
    await assert.rejects(initializeKit(f.root, f.data, kit));
    assert.equal(await f.files.read('AGENTS.md'), 'Instrucciones del kit');
    await rmdir(join(kit, 'ejemplo'));
    await mkdir(join(kit, 'ejemplo'));
    await writeFile(join(kit, 'ejemplo', 'pieza.html'), 'Ejemplo');
    await initializeKit(f.root, f.data, kit);
    assert.equal(await f.files.read('ejemplo/pieza.html'), 'Ejemplo');
  } finally { await f.close(); }
});
test('kit skills arrive in an agency initialized before the kit shipped them', async () => {
  const f = await fixture();
  try {
    await initializeKit(f.root, f.data);
    const skill = '.agents/skills/entrevista/SKILL.md';
    assert.match(await f.files.read(skill), /Armar tu agencia/);
    // The agency edits a file outside the skills, and a skill gets removed as a
    // previous app version would have left the folder.
    await f.files.write('AGENTS.md', 'Instrucciones propias', false);
    await rm(join(f.root, '.agents'), { recursive: true, force: true });
    await initializeKit(f.root, f.data);
    assert.equal(await f.files.read('AGENTS.md'), 'Instrucciones propias');
    assert.match(await f.files.read(skill), /Armar tu agencia/);
    // Every skill the policy allows is there, and nothing else in that folder.
    const folders = (await readdir(join(f.root, '.agents', 'skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(folders, [...KIT_SKILLS].sort());
  } finally { await f.close(); }
});
test('a read-only or edited skill never keeps the app from opening, and the kit text comes back', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'skills '));
  const root = join(dir, 'agencia'), data = join(dir, 'datos'), kit = join(dir, 'kit');
  await mkdir(root); await mkdir(data);
  const skill = join(kit, '.agents', 'skills', 'entrevista');
  await mkdir(skill, { recursive: true });
  const text = '---\nname: entrevista\ndescription: Del kit.\n---\nContenido del kit.\n';
  await writeFile(join(skill, 'SKILL.md'), text);
  await writeFile(join(kit, 'AGENTS.md'), 'Instrucciones del kit\n');
  const target = join(root, '.agents', 'skills', 'entrevista', 'SKILL.md');
  const files = new WorkspaceFiles(root);
  const start = async () => {
    const app = new App(new FakeEngine(), data, () => {}, undefined, files, kit);
    await app.start();
    return app;
  };
  try {
    let app = await start();
    assert.equal(await readFile(target, 'utf8'), text);
    await app.close();

    // Read-only with the kit's bytes: nothing is written, so the start is clean.
    await chmod(target, 0o444);
    app = await start();
    assert.equal(app.snapshot().engine.available, true);
    assert.equal(app.snapshot().notice, undefined);
    await app.close();

    // Edited and read-only: the refresh cannot write it, and that is a notice,
    // never a failed start.
    await chmod(target, 0o666);
    await writeFile(target, 'editado por la agencia', 'utf8');
    await chmod(target, 0o444);
    app = await start();
    assert.equal(app.snapshot().engine.available, true);
    assert.match(app.snapshot().notice ?? '', /No pude poner al día las guías/);
    await app.close();

    // Writable again: the kit's own text comes back.
    await chmod(target, 0o666);
    app = await start();
    assert.equal(await readFile(target, 'utf8'), text);
    await app.close();
  } finally {
    await chmod(target, 0o666).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
test('the app opens but refuses requests when the single kit copy fails, until it works', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'kit copy '));
  const root = join(dir, 'agencia'), data = join(dir, 'datos'), kit = join(dir, 'kit');
  const outside = join(dir, 'afuera');
  await mkdir(root); await mkdir(data); await mkdir(kit); await mkdir(outside);
  await mkdir(join(kit, '.agents', 'skills', 'entrevista'), { recursive: true });
  await writeFile(join(kit, '.agents', 'skills', 'entrevista', 'SKILL.md'), '---\nname: entrevista\ndescription: Del kit.\n---\n');
  await writeFile(join(kit, 'AGENTS.md'), 'Instrucciones del kit\n');
  await mkdir(join(kit, 'ejemplo'));
  await writeFile(join(kit, 'ejemplo', 'pieza.html'), '<p>hola</p>');
  // A broken source stops the full copy into the empty agency.
  await symlink(outside, join(kit, 'invalid-source'), 'junction');
  const files = new WorkspaceFiles(root);
  const app = new App(new FakeEngine(), data, () => {}, undefined, files, kit);
  const replies: Array<{ type: string; text?: string }> = [];
  try {
    await app.start();
    assert.equal(app.snapshot().engine.available, true);
    assert.match(app.snapshot().notice ?? '', /No pude preparar la carpeta de tu agencia/);

    await app.command({ type: 'send', text: 'Un pedido' }, (message) => replies.push(message as { type: string; text?: string }));
    assert.equal(replies[0]?.type, 'problem');
    assert.match(replies[0]?.text ?? '', /No pude preparar la carpeta de tu agencia/);
    assert.equal(app.snapshot().works.length, 0, 'no request runs without the kit');

    // The obstruction goes away: the next request copies the kit and runs.
    await rmdir(join(kit, 'invalid-source'));
    await app.command({ type: 'send', text: 'Un pedido' }, (message) => replies.push(message as { type: string; text?: string }));
    assert.equal(replies[1]?.type, 'selected');
    assert.equal(app.snapshot().works.length, 1);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Instrucciones del kit\n');
    assert.deepEqual(await readdir(outside), [], 'the junction target was not written');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('two requests at once after a failed kit copy never start together', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'kit race '));
  const root = join(dir, 'agencia'), data = join(dir, 'datos'), kit = join(dir, 'kit');
  const outside = join(dir, 'afuera');
  await mkdir(root); await mkdir(data); await mkdir(kit); await mkdir(outside);
  await mkdir(join(kit, '.agents', 'skills', 'entrevista'), { recursive: true });
  await writeFile(join(kit, '.agents', 'skills', 'entrevista', 'SKILL.md'), '---\nname: entrevista\ndescription: Del kit.\n---\n');
  await writeFile(join(kit, 'AGENTS.md'), 'Instrucciones del kit\n');
  await mkdir(join(kit, 'ejemplo'));
  await writeFile(join(kit, 'ejemplo', 'pieza.html'), '<p>hola</p>');
  await symlink(outside, join(kit, 'invalid-source'), 'junction');
  const files = new WorkspaceFiles(root);
  const app = new App(new FakeEngine(), data, () => {}, undefined, files, kit);
  const replies: Array<{ type: string; text?: string }> = [];
  try {
    await app.start();
    assert.match(app.snapshot().notice ?? '', /No pude preparar la carpeta de tu agencia/);
    await rmdir(join(kit, 'invalid-source'));
    // Both requests find the copy broken and try again. They share one copy:
    // a second one racing the marker would leave a false failure notice.
    await Promise.all([
      app.command({ type: 'send', text: 'Uno' }, (message) => replies.push(message as { type: string; text?: string })),
      app.command({ type: 'send', text: 'Dos' }, (message) => replies.push(message as { type: string; text?: string })),
    ]);
    assert.equal(replies.filter((reply) => reply.type === 'selected').length, 1);
    assert.equal(replies.filter((reply) => reply.type === 'problem').length, 1);
    assert.match(replies.find((reply) => reply.type === 'problem')?.text ?? '', /Esperá a que termine/);
    assert.equal(app.snapshot().works.length, 1);
    assert.equal(
      (await readdir(data)).filter((name) => name.startsWith('kit-initialized-')).length,
      1,
      'the copy leaves one marker',
    );
    assert.equal(app.snapshot().notice, undefined, 'no false failure notice');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('a successful copy clears the kit notice even when the request cannot start', async () => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'kit notice '));
  const root = join(dir, 'agencia'), data = join(dir, 'datos'), kit = join(dir, 'kit');
  const outside = join(dir, 'afuera');
  await mkdir(root); await mkdir(data); await mkdir(kit); await mkdir(outside);
  await mkdir(join(kit, '.agents', 'skills', 'entrevista'), { recursive: true });
  await writeFile(join(kit, '.agents', 'skills', 'entrevista', 'SKILL.md'), '---\nname: entrevista\ndescription: Del kit.\n---\n');
  await writeFile(join(kit, 'AGENTS.md'), 'Instrucciones del kit\n');
  await mkdir(join(kit, 'ejemplo'));
  await writeFile(join(kit, 'ejemplo', 'pieza.html'), '<p>hola</p>');
  await symlink(outside, join(kit, 'invalid-source'), 'junction');
  const engine = new FakeEngine();
  const app = new App(engine, data, () => {}, undefined, new WorkspaceFiles(root), kit);
  const replies: Array<{ type: string; text?: string }> = [];
  try {
    await app.start();
    assert.match(app.snapshot().notice ?? '', /No pude preparar la carpeta de tu agencia/);
    // The copy will work this time, but the account is gone: the request stops
    // before it starts. The old failure notice is no longer true.
    engine.connected = false;
    await rmdir(join(kit, 'invalid-source'));
    await app.command({ type: 'send', text: 'Un pedido' }, (message) => replies.push(message as { type: string; text?: string }));
    assert.equal(replies[0]?.type, 'problem');
    assert.match(replies[0]?.text ?? '', /cuenta de ChatGPT está desconectada/);
    assert.equal(app.snapshot().notice, undefined, 'the kit failure notice is gone');
    assert.equal(app.snapshot().works.length, 0);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Instrucciones del kit\n');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('fetch with explicit test-only local grant, photos, append, SSRF and redirect rejection', async () => {
  const f = await fixture();
  const server = createServer((req,res) => {
    if (req.url === '/redirect') { res.writeHead(302,{location:'http://127.0.0.2/secret'}).end(); return; }
    if (req.url === '/photo') { res.writeHead(200,{'content-type':'image/png'}).end(photoFixture()); return; }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<h1>Viaje</h1><table><tr><td>Hotel A</td><td>7 noches</td><td>USD 1.250</td></tr></table><img src="/photo">');
  });
  await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    await rememberUserUrls(f.data,`${url} ${url}/redirect`);
    await assert.rejects(traer(f.files,{url, destination:'rechazada'},f.options));
    const result = await traer(f.files,{url,destination:'oferta'},{...f.options,testOrigin:url});
    assert.equal(result.photos?.length,1);
    const old = await f.files.read('oferta/fuente.md');
    await traer(f.files,{destination:'oferta',notes:'La usuaria confirma 5 kg.'},f.options);
    assert.ok((await f.files.read('oferta/fuente.md')).startsWith(old));
    await assert.rejects(traer(f.files,{url: url+'/redirect',destination:'redirección'},{...f.options,testOrigin:url}));
    for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.0.1','::1','::ffff:127.0.0.1','fc00::1']) assert.equal(publicAddress(address),false,address);
  } finally { await new Promise<void>(r => server.close(() => r())); await f.close(); }
});
test('real Edge: citation failures, exact PNG, PDF, overflow, broken fonts and blocked resources', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    await initializeKit(f.root,f.data);
    const input = {html:'ejemplo/pieza.html', source:'ejemplo/fuente.md', report:'control.md', rules:'ejemplo/rules.json'};
    assert.equal((await controlar(f.files,input)).ok,true);
    const draw = await dibujar(f.files,{html:input.html,destination:'salida',width:1080,height:1920});
    assert.equal(draw.ok,true,JSON.stringify(draw));
    const png = await readFile(join(f.root,'salida/pieza-1.png'));
    assert.equal(png.readUInt32BE(16),1080); assert.equal(png.readUInt32BE(20),1920);
    assert.equal((await readFile(join(f.root,'salida/piezas.pdf'))).subarray(0,4).toString(),'%PDF');
    const html = await f.files.read(input.html);
    await f.files.write('multiple.html', html.replace('</body>', html.match(/<section[\s\S]*<\/section>/)![0] + '</body>'));
    const multiple = await dibujar(f.files,{html:'multiple.html',destination:'multiple',width:1080,height:1920});
    assert.equal(multiple.ok,true,JSON.stringify(multiple)); assert.equal(multiple.files.length,4);
    await f.files.write('wrong.html',html.replace('"7":3','"7":1'));
    assert.equal((await controlar(f.files,{...input,html:'wrong.html'})).ok,false);
    await f.files.write('missing.html',html.replace('data-cites', 'data-unused'));
    assert.equal((await controlar(f.files,{...input,html:'missing.html'})).ok,false);
    await f.files.write('overflow.html',html.replace('</style>','p{width:10px;height:10px;overflow:hidden}</style>'));
    assert.equal((await dibujar(f.files,{html:'overflow.html',destination:'overflow',width:1080,height:1920})).ok,false);
    await f.files.write('broken.woff2','not a font');
    await f.files.write('font.html',html.replace('</style>',"@font-face{font-family:Broken;src:url('broken.woff2')}p{font-family:Broken}</style>"));
    await assert.rejects(dibujar(f.files,{html:'font.html',destination:'font',width:1080,height:1920}),/fuentes/);
    await f.files.write('remote.html',html.replace('</section>','<img src="http://127.0.0.1:1/private"></section>'));
    await assert.rejects(dibujar(f.files,{html:'remote.html',destination:'remote',width:1080,height:1920}),/bloquearon/);
  } finally { await f.close(); }
});
test('real MCP stdio client discovers tourism tools and registers a template from a drawn PDF', { timeout: 300000 }, async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,join(process.cwd(),'server/src/tools/mcp.ts'),f.root,f.options.allowedUrls],stderr:'pipe'});
  const client = new Client({name:'verification',version:'1.0'});
  try {
    await initializeKit(f.root,f.data);
    await connectKitClient(client, transport);
    assert.deepEqual((await listKitTools(client)).tools.map(t=>t.name).sort(),[...BITACORA_TOOLS].sort());
    for (const [name,args] of [
      ['traer',{destination:'ejemplo',notes:'Confirmado por la usuaria: 5 kg.'}],
      ['controlar',{html:'ejemplo/pieza.html',source:'ejemplo/fuente.md',report:'control.md',rules:'ejemplo/rules.json'}],
      ['dibujar',{html:'ejemplo/pieza.html',destination:'mcp salida',width:1080,height:1920}],
    ] as const) {
      const response = await callKitTool(client, name, args);
      assert.ok(!response.isError,JSON.stringify(response));
      assert.ok(!JSON.stringify(response).includes('"ok":false'),JSON.stringify(response));
    }
    assert.equal((await callKitTool(client, 'traer', {url:'http://127.0.0.1',destination:'bloqueado'})).isError,true);
    async function call(name: string, args: Record<string, unknown> = {}) {
      const response = await callKitTool(client, name, args);
      assert.ok(!response.isError, JSON.stringify(response));
      const content = response.content;
      assert.ok(Array.isArray(content));
      const first = content[0];
      assert.equal(first.type, 'text');
      return { data: JSON.parse(first.text), content };
    }
    assert.deepEqual((await call('listar_plantillas')).data, []);
    const pdf = await call('mirar_pdf', { path: 'mcp salida/piezas.pdf' });
    assert.equal(pdf.data.totalPages, 1);
    assert.equal(pdf.data.nextPage, null);
    assert.ok(pdf.data.pages[0].text.length > 0);
    assert.equal(pdf.content[1].mimeType, 'image/png');
    const added = (await call('sumar_plantilla', {
      name: 'Propuestas', purpose: 'Cotizaciones', paths: ['ejemplo/pieza.html', 'mcp salida/piezas.pdf'],
    })).data;
    assert.equal(added.origin, 'agent');
    const read = (await call('leer_plantilla', { id: added.id })).data;
    assert.deepEqual(read.files, ['pieza.html', 'piezas.pdf']);
    assert.ok(read.paths.every((path: string) => path.startsWith('.bitacora/plantillas/')));
    assert.equal((await call('actualizar_plantilla', { id: added.id, name: 'Cotizaciones editables' })).data.name, 'Cotizaciones editables');
    assert.equal((await call('listar_plantillas')).data.length, 1);
    assert.equal((await callKitTool(client, 'sumar_plantilla', {
      name: 'Fuera', purpose: 'Cotizaciones', paths: ['../fuera.html'],
    })).isError, true);
  } finally { await client.close(); await f.close(); }
});
