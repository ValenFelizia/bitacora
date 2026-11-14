import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AgencyFiles } from '../src/tools/paths';
import { controlar } from '../src/tools/check';
import { traer } from '../src/tools/fetch';
import { rememberUserUrls, allowedUrlsPath } from '../src/allowed-urls';
import { photoFixture } from './photo-fixture';

async function fixture() {
  const base=join(process.env.LOCALAPPDATA!,'Bitacora-dev/issue6');await mkdir(base,{recursive:true});
  return new AgencyFiles(await mkdtemp(join(base,'visibility ñ ')));
}
test('text visibility uses rendered text ranges, including display contents, and excludes hidden text',async t=>{
  const cases=[
    ['contents','<span style="display:contents">999</span>',1],
    ['nested','<span style="display:contents"><span style="display:contents">999</span></span>',1],
    ['mixed block','<p>12 <span style="display:contents">999</span> 34</p>',3],
    ['none','<span style="display:none">999</span>',0],
    ['visibility','<span style="display:contents;visibility:hidden">999</span>',0],
    ['hidden','<span hidden>999</span>',0],
    ['opacity ancestor','<div style="opacity:0"><span style="display:contents">999</span></div>',0],
    ['clipped','<div style="width:0;height:0;overflow:hidden"><span style="display:contents">999</span></div>',0],
  ] as const;
  for(const [name,body,count] of cases)await t.test(name,async()=>{
    const files=await fixture();await files.write('source.md','Nada');await files.write('piece.html',`<!doctype html><body>${body}</body>`);
    const result=await controlar(files,{html:'piece.html',source:'source.md',report:'report.md'});
    assert.equal(result.checked,count);assert.equal(result.ok,count===0);
  });
  for(const [name,body] of [
    ['svg text','<svg><text x="10" y="30">999</text></svg>'],
    ['contents pseudo','<style>span:before{content:"999"}</style><span style="display:contents"></span>'],
  ])await t.test(name,async()=>{
    const files=await fixture();await files.write('source.md','Nada');await files.write('piece.html',`<!doctype html><body>${body}</body>`);
    await assert.rejects(controlar(files,{html:'piece.html',source:'source.md',report:'report.md'}),/Sacá/);
  });
});
test('real image dimensions override small HTML display dimensions, while real icons are excluded',async()=>{
  const files=await fixture(),data=await fixture();const large=photoFixture(1600,1200),small=photoFixture(16,16);
  const server=createServer((req,res)=>{
    if(req.url==='/large.png'||req.url==='/small.png'){res.writeHead(200,{'content-type':'image/png'}).end(req.url==='/large.png'?large:small);return;}
    res.writeHead(200,{'content-type':'text/html'}).end('<img src="/large.png" width="320" height="240"><img src="/small.png" width="1600" height="1200">');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    await rememberUserUrls(data.root,origin);
    const result=await traer(files,{url:origin,destination:'offer'},{allowedUrls:allowedUrlsPath(data.root),testOrigin:origin});
    assert.equal(result.photoDetails?.length,1);assert.equal(result.photoDetails?.[0].width,1600);assert.equal(result.photoDetails?.[0].height,1200);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
