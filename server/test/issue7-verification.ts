// Prueba manual reproducible sin inferencia; ejecutá con npx tsx.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callKitTool, connectKitClient } from './mcp-client';
import { initializeKit } from '../src/tools/kit';
import { allowedUrlsPath } from '../src/allowed-urls';
import { withPage } from '../src/tools/page';
import { AgencyFiles } from '../src/tools/paths';

const base = resolve(process.env.LOCALAPPDATA!, 'Bitacora-dev/issue7');
const root = join(base,'agencia'), data = join(base,'datos');
const evidence = resolve('docs/verification/issue7');
await mkdir(root,{recursive:true}); await mkdir(data,{recursive:true});
const client = new Client({name:'entrevista-sin-inferencia',version:'1.0'});
const calls: unknown[] = [];
const transport = new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,resolve('server/src/tools/mcp.ts'),root,allowedUrlsPath(data)],stderr:'pipe'});
async function save(path:string, text:string) { await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),text,'utf8'); }
async function call(name:string,args:Record<string,unknown>,error=false) {
  const result = await callKitTool(client, name, args); calls.push({name,args,result});
  if(result.isError && !error && name==='dibujar') console.log(await withPage(new AgencyFiles(root),String(args.html),page=>page.evaluate(()=>Array.from(document.querySelectorAll('h1,h2,footer')).map(e=>({tag:e.tagName,text:e.textContent,client:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight],box:JSON.stringify(e.getBoundingClientRect())})))));
  assert.equal(!!result.isError,error,JSON.stringify(result)); return result;
}
try {
  await initializeKit(root,data);
  await connectKitClient(client, transport);
  await mkdir(join(root,'adjuntos'),{recursive:true});
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1080,height:1080}});
    await page.setContent('<body style="margin:0;background:#e8ede3;color:#153e3b;display:grid;place-content:center;height:1080px;font:64px Arial;text-align:center"><div style="font-size:180px">◒</div><b>Rumbo Sur</b><div>VIAJES</div></body>');
    await page.screenshot({path:join(root,'adjuntos/logo.png')});
    await page.setContent('<body style="margin:0;padding:90px;background:#153e3b;color:#faf6ed;font:45px Arial"><p>Rumbo Sur Viajes</p><h1>Una pausa<br>para vos.</h1><div style="padding:60px;background:#e3a45b;color:#153e3b">Consultame y lo armamos.</div><p>Escribime — Laura</p></body>');
    await page.screenshot({path:join(root,'adjuntos/captura.png')});
  } finally { await browser.close(); }
  const common = '<img class="logo" src="../adjuntos/logo.png" alt="Rumbo Sur Viajes"><p class="eyebrow">Rumbo Sur Viajes</p><h1>Una pausa<br>para vos.</h1><div class="details"><p>Hotel de ejemplo</p><p data-cites=\'{"7":3}\'>7 noches</p><p data-cites=\'{"1.250":3}\'>Desde USD 1.250</p><p>Por persona en base doble,<br>más tasas e impuestos.</p></div><footer><p>Escribime y lo armamos — Laura</p><p class="note">Datos ficticios. No publicar.</p></footer>';
  const styles = [
    'background:#faf6ed;color:#153e3b;font-family:Manrope; border-top:28px solid #e3a45b',
    'background:#153e3b;color:#faf6ed;font-family:"Source Sans 3"',
    'background:#e8ede3;color:#153e3b;font-family:Manrope;text-align:center;border:36px solid #153e3b',
  ];
  const variants = ['h1{font-family:Lora}', 'h1{font-family:Outfit} .details{background:#e3a45b;color:#153e3b;padding:36px}', 'h1{font-family:Manrope;font-size:86px} .eyebrow{font:600 56px Caveat}'];
  for(let i=0;i<3;i++) {
    await save(`muestras/opcion-${i+1}.html`, `<!doctype html><html lang="es"><meta charset="utf-8"><link rel="stylesheet" href="../fuentes/fuentes.css"><style>*{box-sizing:border-box}body{margin:0} [data-piece]{width:1080px;height:1920px;padding:78px;display:flex;flex-direction:column;justify-content:space-between;font-size:38px;line-height:1.35;${styles[i]}}h1{font-size:110px;line-height:1.3;margin:28px 0;padding:8px 0}p{margin:16px 0}.logo{width:180px;height:180px}.note{font-size:28px}${variants[i]}</style><body><section data-piece><p data-cites='{"${i+1}":${i+4}}'>${i+1}</p>${common}</section></body></html>`);
  }
  await save('muestras/fuente.md', (await readFile(join(root,'ejemplo/fuente.md'),'utf8')).trimEnd()+'\nOpciones visuales de esta comparación: 1\nOpciones visuales de esta comparación: 2\nOpciones visuales de esta comparación: 3\n');
  for(let i=1;i<=3;i++) {
    await call('controlar',{html:`muestras/opcion-${i}.html`,source:'muestras/fuente.md',report:`muestras/control-${i}.md`});
    await call('dibujar',{html:`muestras/opcion-${i}.html`,destination:`muestras/salida-${i}`,width:1080,height:1920});
  }
  // Respuesta de la usuaria simulada: «La 2». Recién ahora se guarda la marca.
  await save('marca/datos.md','Nombre: Rumbo Sur Viajes\nFirma: Escribime y lo armamos — Laura\nWhatsApp: 11 4567 8901\nLegajo: 12345\nInstagram: @rumbosurviajes\n');
  await save('marca/voz.md','Hablá de vos, con calidez y sin emojis.\nFirma: Escribime y lo armamos — Laura\nFrase que usa: Escribime y lo armamos.\nFrases que evita: no indicó ninguna; no inventar preferencias.\n');
  await save('marca/estilo.json',JSON.stringify({opcion:2,colores:[{nombre:'Verde profundo',valor:'#153e3b',uso:'fondo y texto sobre claro'},{nombre:'Crema',valor:'#faf6ed',uso:'texto sobre verde'},{nombre:'Arena',valor:'#e3a45b',uso:'bloques y acentos'}],fuentes:{titulos:'Outfit',lectura:'Source Sans 3'},ajustes:{ancho:1080,alto:1920,padding:90,composicion:'Bloques como la captura actual'}},null,2)+'\n');
  await cp(join(root,'adjuntos/logo.png'),join(root,'marca/logo.png'));
  let template = await readFile(join(root,'ejemplo/plantilla-vertical.html'),'utf8');
  template = template.replaceAll('Manrope','"Source Sans 3"').replaceAll('Lora','Outfit').replaceAll('#faf6ed','#TEMP').replaceAll('#193b38','#faf6ed').replaceAll('#TEMP','#153e3b');
  const footer = '<p>Escribime y lo armamos — Laura</p><p class="note" data-cites=\'{"11":"m:3","4567":"m:3","8901":"m:3"}\'>WhatsApp: 11 4567 8901</p><p class="note" data-cites=\'{"12345":"m:4"}\'>Legajo: 12345</p><p class="note">@rumbosurviajes</p>';
  template = template.replaceAll('<footer>',`<footer>${footer}`).replace('<p>Consultame y lo armamos.</p>','').replaceAll('<section data-piece>', '<section data-piece><img src="../marca/logo.png" alt="Rumbo Sur Viajes" style="width:150px;height:150px">');
  template = template.replace('h2{font-size:78px}', 'h2{font-size:78px}.price{background:#e3a45b;color:#153e3b;padding:20px;font-size:80px!important}footer p{margin:8px 0}');
  await save('plantillas/vertical.html',template);
  await save('propuestas/prueba/pieza.html',template.replaceAll('../fuentes/','../../fuentes/').replaceAll('../marca/','../../marca/'));
  const input={html:'propuestas/prueba/pieza.html',source:'ejemplo/fuente.md',brand:'marca/datos.md',rules:'ejemplo/rules.json',report:'propuestas/prueba/control.md'};
  await call('controlar',input);
  await call('dibujar',{html:input.html,destination:'propuestas/prueba/salida',width:1080,height:1920});
  // Debe fallar con la fuente elegida ausente, sin sustituirla silenciosamente.
  const font='fuentes/outfit/outfit-1.woff2';
  await rename(join(root,font),join(root,font+'.oculta'));
  try { await call('dibujar',{html:input.html,destination:'debe-fallar',width:1080,height:1920},true); }
  finally { await rename(join(root,font+'.oculta'),join(root,font)); }
  await mkdir(evidence,{recursive:true});
  for (const folder of ['marca','plantillas','adjuntos','muestras','propuestas','ejemplo','fuentes']) await cp(join(root,folder),join(evidence,folder),{recursive:true});
  await writeFile(join(evidence,'mcp.json'),JSON.stringify(calls,null,2)+'\n');
  console.log(`PASS: ${calls.length} llamadas MCP, evidencia en ${evidence}`);
} finally {
  await client.close();
  // Este script solo crea y elimina la carpeta exacta issue7.
  assert.equal(base,resolve(process.env.LOCALAPPDATA!,'Bitacora-dev/issue7'));
  await rm(base,{recursive:true,force:true});
}
