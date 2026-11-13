import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { traer } from '../server/src/tools/fetch';
import { AgencyFiles } from '../server/src/tools/paths';
import { rememberUserUrls, allowedUrlsPath } from '../server/src/allowed-urls';

const base = join(process.env.LOCALAPPDATA!, 'Bitacora-dev/issue6');
await mkdir(base,{recursive:true});
const dir = await mkdtemp(join(base,'descarga pública ñ '));
const workspace = join(dir,'agencia'), data = join(dir,'datos');
const url = process.argv[2] || 'https://www.google.com/';
await mkdir(workspace); await mkdir(data);
try {
  // Operator explicitly supplies the public URL to this verification script.
  await rememberUserUrls(data,url);
  const resolved: unknown[] = [];
  const files = new AgencyFiles(workspace);
  const result = await traer(files,{url,destination:'oferta'},{allowedUrls:allowedUrlsPath(data),resolve:async host=>{
    const addresses = await lookup(host,{all:true}); resolved.push({host,addresses}); return addresses;
  }});
  const source = await files.read(result.source);
  const evidence = {date:new Date().toISOString(),node:process.version,url,resolved,result,sourceBytes:Buffer.byteLength(source),sourceSha256:createHash('sha256').update(source).digest('hex'),excerpt:source.slice(0,1500),modelRequests:0};
  await writeFile(`docs/verification/issue6/public-fetch-${new URL(url).hostname}.json`,JSON.stringify(evidence,null,2),'utf8');
  console.log(`PASS: ${url}; ${Buffer.byteLength(source)} bytes de fuente, ${result.photos?.length} fotos.`);
} finally { await rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:300}); }
