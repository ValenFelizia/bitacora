import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { AgencyFiles } from '../src/tools/paths';
import { controlar } from '../src/tools/check';
import { dibujar } from '../src/tools/draw';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { photoFixture } from './photo-fixture';
import { traer } from '../src/tools/fetch';
import { rememberUserUrls, allowedUrlsPath } from '../src/allowed-urls';

async function fixture() {
  const base=join(process.env.LOCALAPPDATA!,'Bitacora-dev/issue6');await mkdir(base,{recursive:true});
  return new AgencyFiles(await mkdtemp(join(base,'greptile ñ ')));
}
test('visible numeric tokens span adjacent inline nodes and use a common citation ancestor',async t=>{
  const cases=[
    ['split span','<p data-cites=\'{"1":3,"250":4}\'>1<span>250</span></p>',false],
    ['split thousands','<p data-cites=\'{"1":3,"670":5}\'>1.<b>670</b></p>',false],
    ['split superscript','<p data-cites=\'{"1":3,"250":4}\'>USD 1<sup>250</sup></p>',false],
    ['split inline-block','<p data-cites=\'{"1":3,"250":4}\'>1<span style="display:inline-block">250</span></p>',false],
    ['whole ancestor citation','<p data-cites=\'{"1250":6}\'>1<span>250</span></p>',true],
    ['whole thousands citation','<p data-cites=\'{"1.670":7}\'>1.<b>670</b></p>',true],
    ['sibling blocks','<div><p data-cites=\'{"1":3}\'>1</p><p data-cites=\'{"250":4}\'>250</p></div>',true],
    ['line break','<p data-cites=\'{"1":3,"250":4}\'>1<br>250</p>',true],
    ['table cells','<table><tr><td data-cites=\'{"1":3}\'>1</td><td data-cites=\'{"250":4}\'>250</td></tr></table>',true],
    ['visible spacing','<p data-cites=\'{"1":3,"250":4}\'>1<span style="margin-left:20px">250</span></p>',true],
    ['whole token only','<p data-cites=\'{"5":8}\'>5</p>',false],
  ] as const;
  for(const [name,body,ok] of cases) await t.test(name,async()=>{
    const files=await fixture();
    await files.write('source.md','# Fuente\n\n1\n250\n670\n1250\n1670\n15');
    await files.write('piece.html',`<!doctype html><meta charset="utf-8"><body>${body}</body>`);
    const result=await controlar(files,{html:'piece.html',source:'source.md',report:'report.md'});
    assert.equal(result.ok,ok,JSON.stringify(result));
  });
});
test('fetch selects content photos from lazy, picture, background and srcset instead of logos and tiny images',async()=>{
  const files=await fixture(),data=await fixture();
  const image=photoFixture(),icon=photoFixture(16,16),requests:string[]=[];
  const server=createServer((req,res)=>{
    requests.push(req.url!);
    if(req.url?.endsWith('.png')){res.writeHead(200,{'content-type':'image/png'}).end(req.url.includes('tiny')?icon:image);return;}
    res.writeHead(200,{'content-type':'text/html'}).end(req.url==='/empty' ? '<img class="logo" src="/logo.png"><img src="/tiny.png">' : `<header><img class="logo" src="/logo.png"></header><main><img loading="lazy" src="/tiny.png" data-src="/lazy.png"><picture><source srcset="/tiny.png 16w, /picture.png 900w"><img src="/tiny.png"></picture><div data-bg-image="/background.png"></div><div style="background-image:url('/css.png')"></div></main>`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    await rememberUserUrls(data.root,`${origin}/page ${origin}/empty`);
    const options={allowedUrls:allowedUrlsPath(data.root),testOrigin:origin};
    const result=await traer(files,{url:origin+'/page',destination:'offer'},options);
    assert.equal(result.photos?.length,4);assert.ok(!requests.includes('/logo.png'));assert.ok(!requests.includes('/tiny.png'));
    const details=(result as any).photoDetails;assert.equal(details.length,4);assert.ok(details.every((p:any)=>p.width===900 && p.height===600));
    const empty=await traer(files,{url:origin+'/empty',destination:'empty'},options);assert.equal(empty.photos?.length,0);assert.match((empty as any).photoSummary,/pedile.*usuaria/i);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('PDF keeps screen content, page count and exact page dimensions despite print overrides',async()=>{
  const files=await fixture();
  await files.write('piece.html',`<!doctype html><style>body{margin:0}[data-piece]{width:1080px;height:1920px;box-sizing:border-box;padding:1px;font:40px Arial}.alternate{display:none}@media print{.screen{display:none}.alternate{display:block}[data-piece]{width:100px!important;height:100px!important}}</style><body><section data-piece><p class="screen">SCREEN_A</p><p class="alternate">PRINT_CHANGED</p></section><section data-piece><p class="screen">SCREEN_B</p></section></body>`);
  const result=await dibujar(files,{html:'piece.html',destination:'out',width:1080,height:1920});assert.ok(result.ok,JSON.stringify(result));
  const pdf=await files.readBuffer('out/piezas.pdf'), raw=pdf.toString('latin1');
  assert.equal((raw.match(/\/Type\s*\/Page\b/g)||[]).length,2);
  for(const box of raw.matchAll(/\/MediaBox\s*\[([\d. ]+)\]/g)) assert.deepEqual(box[1].trim().split(/\s+/).map(Number),[0,0,810,1440]);
  // Decode only the Flate streams and ToUnicode maps emitted by Edge in this fixture.
  const streams:string[]=[];
  for(const match of raw.matchAll(/stream\r?\n/g)) {
    const end=raw.indexOf('endstream',match.index!+match[0].length);
    try{streams.push(inflateSync(pdf.subarray(match.index!+match[0].length,end)).toString('latin1'));}catch{}
  }
  const glyphs=new Map<number,string>();
  for(const stream of streams) {
    for(const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for(const pair of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) glyphs.set(parseInt(pair[1],16),String.fromCodePoint(parseInt(pair[2],16)));
    for(const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for(const range of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
      const start=parseInt(range[1],16),end=parseInt(range[2],16),unicode=parseInt(range[3],16);
      for(let i=start;i<=end;i++) glyphs.set(i,String.fromCodePoint(unicode+i-start));
    }
  }
  const text=streams.flatMap(s=>Array.from(s.matchAll(/<([\da-f]+)>\s*Tj/gi),m=>m[1].match(/.{4}/g)!.map(hex=>glyphs.get(parseInt(hex,16))||'').join(''))).join('\n');
  assert.match(text,/SCREEN_A/);assert.match(text,/SCREEN_B/);assert.doesNotMatch(text,/PRINT_CHANGED/);
});
test('control report rejects Windows-equivalent input paths before changing any input',async t=>{
  for(const [input,report] of [['source.md','./SOURCE.MD'],['rules.md','sub/../rules.md'],['piece.md','PIECE.md']] as const) await t.test(input,async()=>{
    const files=await fixture();
    await files.write('source.md','7 noches');await files.write('rules.md','{}');
    await files.write('piece.html','<!doctype html><p data-cites=\'{"7":1}\'>7 noches</p>');
    await files.write('piece.md',await files.read('piece.html'));
    const before=await files.read(input);
    await assert.rejects(controlar(files,{html:input==='piece.md' ? input : 'piece.html',source:'source.md',rules:'rules.md',report}),/informe.*entrada/i);
    assert.equal(await files.read(input),before);
  });
});
test('draw rejects outputs that alias its input before rendering',async()=>{
  const files=await fixture();await files.write('out/piezas.pdf','<!doctype html><p>pieza</p>');
  await assert.rejects(dibujar(files,{html:'out/PIEZAS.pdf',destination:'./out',width:1080,height:1920}),/salida.*entrada/i);
  assert.equal(await files.read('out/piezas.pdf'),'<!doctype html><p>pieza</p>');
});
