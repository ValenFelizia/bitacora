import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
    assert.match(await f.files.read('ejemplo/pieza.html'), /data-cites/);
  } finally { await f.close(); }
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
test('real MCP stdio client discovers and calls all three tools', { timeout: 180000 }, async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,join(process.cwd(),'server/src/tools/mcp.ts'),f.root,f.options.allowedUrls],stderr:'pipe'});
  const client = new Client({name:'verification',version:'1.0'});
  try {
    await initializeKit(f.root,f.data);
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['controlar','dibujar','traer']);
    for (const [name,args] of [
      ['traer',{destination:'ejemplo',notes:'Confirmado por la usuaria: 5 kg.'}],
      ['controlar',{html:'ejemplo/pieza.html',source:'ejemplo/fuente.md',report:'control.md',rules:'ejemplo/rules.json'}],
      ['dibujar',{html:'ejemplo/pieza.html',destination:'mcp salida',width:1080,height:1920}],
    ] as const) {
      const response = await client.callTool({name,arguments:args});
      assert.ok(!response.isError,JSON.stringify(response));
      assert.ok(!JSON.stringify(response).includes('"ok":false'),JSON.stringify(response));
    }
    assert.equal((await client.callTool({name:'traer',arguments:{url:'http://127.0.0.1',destination:'bloqueado'}})).isError,true);
  } finally { await client.close(); await f.close(); }
});
