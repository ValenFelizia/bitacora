import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callKitTool, connectKitClient } from './mcp-client';
import { serve } from '../src/server';
import { AgencyFiles } from '../src/tools/paths';
import { allowedUrlsPath, readAllowedUrls } from '../src/allowed-urls';
import { FakeEngine } from './fake-engine';
import type { Snapshot } from '../src/contracts';
import { photoFixture } from './photo-fixture';
import { screenHeaders, screenProtocols, screenSecret } from './screen-fixture';

// Intentionally retain fixture data under issue6: the operator owns its cleanup.
export async function verifyKitIntegration(evidence?: string) {
  const base=join(process.env.LOCALAPPDATA!,'Bitacora-dev/issue6');
  await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'integración ñ ')), workspace=join(dir,'agencia'), data=join(dir,'datos');
  const files=new AgencyFiles(workspace);
  const png=photoFixture();
  const operator=createServer((req,res)=>{
    if(req.url==='/foto') {res.writeHead(200,{'content-type':'application/octet-stream'}).end(png);return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<h1>Oferta de prueba</h1><p>7 noches, desde USD 1.250 por persona en base doble, más tasas.</p><img src="/foto">');
  });
  await new Promise<void>(r=>operator.listen(0,'127.0.0.1',r));
  const operatorOrigin=`http://127.0.0.1:${(operator.address() as {port:number}).port}`, url=operatorOrigin+'/oferta';
  const engine=new FakeEngine();
  engine.start=async()=>{assert.match(await files.read('AGENTS.md'),/Las tres herramientas/);};
  let client:Client|undefined, ws:WebSocket|undefined;
  let server:Awaited<ReturnType<typeof serve>>|undefined;
  let browser:import('playwright-core').Browser|undefined, vite:import('vite').ViteDevServer|undefined;
  let snapshot:Snapshot|undefined;
  const calls:Record<string,unknown>={}, errors:string[]=[];
  const origin='http://127.0.0.1:5326';
  async function until(check:()=>boolean, label:string, timeoutMs=240000) {
    const deadline=Date.now()+timeoutMs;
    while(!check()) {if(errors.length) throw new Error(errors.join('\n')); if(Date.now()>deadline) throw new Error(`Integration timeout waiting for ${label} after ${timeoutMs}ms`);await new Promise(r=>setTimeout(r,20));}
  }
  try {
    server=await serve(engine,data,0,origin,workspace,undefined,screenSecret);
    assert.ok((await readdir(data)).some(n=>n.startsWith('kit-initialized-')));
    const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,resolve('server/test/kit-mcp.ts'),workspace,allowedUrlsPath(data),operatorOrigin],stderr:'pipe'});
    client=new Client({name:'kit-integration',version:'1.0'});await connectKitClient(client,transport);
    async function tool(name:string,args:Record<string,unknown>) {
      const response=await callKitTool(client!,name,args);
      assert.ok(!response.isError,JSON.stringify(response));
      const value=JSON.parse((response.content as {text:string}[])[0].text);
      assert.notEqual(value.ok,false,JSON.stringify(value)); calls[name]=value;return value;
    }
    engine.send=async(conversationId,text,attachments=[])=>{
      assert.equal(text,`Prepará esta oferta: ${url}`);assert.equal(attachments.length,1);
      assert.deepEqual(await readAllowedUrls(allowedUrlsPath(data)),[url]);
      for(const link of ['https://contenido-adjunto.example/','https://www.nombre-adjunto.example.txt/','https://adaptador.example/']) {
        const result=await callKitTool(client!,'traer',{url:link,destination:'rechazada'});
        assert.equal(result.isError,true);assert.match(JSON.stringify(result),/usuaria/);
      }
      const fetched=await tool('traer',{url,destination:'propuestas/prueba'});assert.equal(fetched.photos.length,1);
      const source=await files.read(fetched.source);
      const line=source.split('\n').findIndex(s=>s.includes('7 noches'))+1;assert.ok(line>0);
      const html=(await files.read('ejemplo/pieza.html')).replaceAll(':3}',`:${line}}`);
      await files.write('propuestas/prueba/pieza.html',html);
      await tool('controlar',{html:'propuestas/prueba/pieza.html',source:fetched.source,report:'propuestas/prueba/control.md'});
      await tool('dibujar',{html:'propuestas/prueba/pieza.html',destination:'propuestas/prueba/salida',width:1080,height:1920});
      // Produced during the request to prove exclusions, not just baseline timing.
      await files.write('ejemplo/no-mostrar.png',png);
      await writeFile(join(workspace,'.kit-guard-test.png'),png);
      await writeFile(join(workspace,'.kit-test.tmp'),'temporal de prueba');
      engine.emit({type:'message',conversationId,id:'answer',text:`Preparé las piezas. [Descargar PNG](propuestas/prueba/salida/pieza-1.png) · [Sitio del operador](${url}) · [Correo](mailto:agencia@example.test)`,delta:false});
      engine.emit({type:'finished',conversationId,status:'completed'});
    };
    const baseUrl=`http://127.0.0.1:${server.port}`;
    ws=new WebSocket(baseUrl.replace('http:','ws:')+'/ws',screenProtocols,{origin});
    ws.on('error',err=>{errors.push(err.message);});
    ws.on('message',raw=>{const msg=JSON.parse(String(raw));if(msg.type==='snapshot') snapshot=msg.state; if(msg.type==='problem') errors.push(msg.detail||msg.text);});
    await until(()=>!!snapshot,'initial snapshot',15000);
    ws.send(JSON.stringify({type:'send',text:`Prepará esta oferta: ${url}`,attachments:[{name:'www.nombre-adjunto.example.txt',data:Buffer.from('https://contenido-adjunto.example/').toString('base64')}]}));
    await until(()=>!!snapshot?.works[0]?.messages[0]?.results?.length && !snapshot.works[0].busy,'kit results');
    const results=snapshot!.works[0].messages[0].results!;
    assert.deepEqual(results.map(f=>f.name).sort(),['pieza-1.png','piezas.pdf','todas.png']);
    assert.deepEqual(await readAllowedUrls(allowedUrlsPath(data)),[url]);
    assert.ok(snapshot!.works[0].messages[0].attachments?.length);
    for(const ref of results) {
      const response=await fetch(`${baseUrl}/files?id=${ref.id}`, { headers:screenHeaders });
      assert.equal(response.status,200);
      assert.ok((await response.arrayBuffer()).byteLength>0);
    }
    const image=await readFile(join(workspace,results.find(f=>f.name==='pieza-1.png')!.path));
    assert.equal(image.readUInt32BE(16),1080);assert.equal(image.readUInt32BE(20),1920);
    if(evidence) {
      await mkdir(evidence,{recursive:true});
      for(const ref of results) await copyFile(join(workspace,ref.path),join(evidence,ref.name));
      await copyFile(join(workspace,'propuestas/prueba/control.md'),join(evidence,'control.md'));
      const {createServer:createVite}=await import('vite');
      vite=await createVite({configFile:resolve('web/vite.config.ts'),root:resolve('web'),server:{host:'127.0.0.1',port:5326,strictPort:true,proxy:{'/files':{target:baseUrl,changeOrigin:true},'/ws':{target:baseUrl.replace('http:','ws:'),ws:true,changeOrigin:true}}}});
      await vite.listen();
      const {chromium}=await import('playwright-core');
      browser=await chromium.launch({channel:'msedge'});
      const page=await browser.newPage({viewport:{width:1280,height:1000}});
      await page.goto(origin);
      await page.getByRole('navigation',{name:'Trabajos anteriores'}).getByRole('button').first().click();
      const region=page.getByRole('region',{name:'Resultados del pedido'});
      await region.getByText('pieza-1.png',{exact:true}).waitFor();
      assert.equal(await page.locator('.markdown').getByRole('link',{name:'Descargar PNG',exact:true}).count(),0);
      assert.equal(await page.locator('.markdown').getByRole('link',{name:'Correo',exact:true}).count(),0);
      assert.equal(await page.locator('.markdown').getByRole('link',{name:'Sitio del operador',exact:true}).count(),1);
      assert.equal(await region.getByText('imagen-1.png',{exact:true}).count(),0);
      await page.screenshot({path:join(evidence,'conversation.png'),fullPage:true});
      await page.getByRole('button',{name:'Galería',exact:true}).click();
      await page.getByRole('heading',{name:'Todo lo que creamos'}).waitFor();
      await page.screenshot({path:join(evidence,'gallery.png'),fullPage:true});
      await writeFile(join(evidence,'integration.json'),JSON.stringify({workspace,allowedUrls:await readAllowedUrls(allowedUrlsPath(data)),calls,snapshot,modelRequests:0},null,2),'utf8');
    }
    return {results:results.map(f=>f.name),workspace};
  } finally {
    await browser?.close();await vite?.close();ws?.terminate();await client?.close();await server?.close();
    operator.closeAllConnections();await new Promise<void>(r=>operator.close(()=>r()));
  }
}
