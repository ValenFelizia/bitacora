import { lookup } from 'node:dns/promises';
import { request, Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import { AgencyFiles } from './paths';
import { requireAllowedUrl } from '../allowed-urls';
import { selectPhotos, photoDimensions } from './photos';

export type FetchOptions = {
  allowedUrls: string;
  testOrigin?: string;
  resolve?: (host: string) => Promise<{address: string; family: number}[]>;
  timeoutMs?: number;
};

export function publicAddress(address: string) {
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}
// Only test callers can grant one exact loopback origin. Never exposed by MCP.
export async function download(url: URL, signal: AbortSignal, options: Pick<FetchOptions, 'testOrigin' | 'resolve'> = {}, maxBytes = 5_000_000): Promise<{ data: Buffer; type: string; url: URL }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('La dirección debe ser http o https, sin credenciales.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await new Promise<{address:string;family:number}[]>((resolve,reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort',abort,{once:true});
    (options.resolve ? options.resolve(hostname) : lookup(hostname,{all:true}))
      .then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address)) && url.origin !== options.testOrigin) throw new Error('No se permiten direcciones locales ni privadas.');
  const selected = addresses[0];
  // Pin the validated DNS answer to the connection: no second DNS lookup/rebinding.
  const dispatcher = new Agent({ connect: { autoSelectFamily: false, lookup: (_host, options, cb) => {
    if (options.all) cb(null, [selected]); else cb(null, selected.address, selected.family);
  } } });
  try {
    const response = await request(url, { dispatcher, signal, headersTimeout: 15000, bodyTimeout: 15000, headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Bitacora/0.1',
      accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
    } });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const next = response.headers.location;
      await response.body.dump();
      if (!next || signal.aborted) throw new Error('Redirección incompleta.');
      throw Object.assign(new Error('redirect'), { redirect: new URL(String(next), url) });
    }
    if (response.statusCode !== 200) { await response.body.dump(); throw new Error(`La página respondió ${response.statusCode}.`); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { response.body.destroy(); throw new Error('El archivo supera el límite de tamaño.'); }
      chunks.push(Buffer.from(chunk));
    }
    return { data: Buffer.concat(chunks), type: String(response.headers['content-type'] || ''), url };
  } finally { await dispatcher.destroy(); }
}
async function follow(url: URL, signal: AbortSignal, options: FetchOptions, maxBytes?: number) {
  for (let i = 0; i < 6; i++) {
    try { return await download(url, signal, options, maxBytes); }
    catch (e) { if (!(e as {redirect?: URL}).redirect) throw e; url = (e as unknown as {redirect: URL}).redirect; }
  }
  throw new Error('Demasiadas redirecciones.');
}
export function decodePage(data: Buffer, type: string) {
  const charset = /charset\s*=\s*["']?([^\s;"'>]+)/i.exec(type)?.[1]
    || /<meta\b[^>]*charset\s*=\s*["']?([^\s;"'>]+)/i.exec(data.subarray(0, 4096).toString('latin1'))?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(data); }
  catch { throw new Error(`La codificación de la página no está admitida: ${charset}.`); }
}
export function photoExtension(data: Buffer) {
  if (data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP') return 'webp';
  throw new Error('Los bytes de la foto no son JPEG, PNG ni WebP.');
}
export async function traer(files: AgencyFiles, input: { url?: string; destination: string; notes?: string }, options: FetchOptions) {
  const source = `${input.destination}/fuente.md`;
  if (!input.url) {
    if (!input.notes?.trim()) throw new Error('Falta la dirección o los datos para agregar.');
    const old = await files.read(source);
    await files.write(source, old + `\n## Datos aportados por la usuaria — ${new Date().toISOString()}\n${input.notes}\n`, false);
    return { source, lines: (await files.read(source)).split('\n').length };
  }
  await requireAllowedUrl(options.allowedUrls, input.url);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 45000);
  const page = await follow(new URL(input.url), signal, options, 2_000_000);
  if (!/text\/html/i.test(page.type)) throw new Error('La dirección no devuelve una página HTML.');
  const $ = load(decodePage(page.data, page.type));
  const photos = selectPhotos($,page.url);
  $('script,style,noscript,svg,nav,footer').remove();
  $('td,th').append(' | '); $('p,div,tr,li,h1,h2,h3,h4,section,br').prepend('\n');
  const lines = $('body').text().split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = `# Fuente\nURL: ${page.url.href}\nConsultada: ${new Date().toISOString()}\n\n${lines.join('\n')}\n` + (input.notes ? `\n## Datos aportados por la usuaria — ${new Date().toISOString()}\n${input.notes}\n` : '');
  await files.write(source, text);
  const saved: string[] = [], warnings: string[] = [];
  const photoDetails:{path:string;url:string;width:number;height:number;bytes:number}[]=[];
  for (const [i, src] of photos.slice(0, 12).entries()) {
    try {
      const photo = await follow(new URL(src, page.url), signal, options);
      const ext = photoExtension(photo.data);
      const {width,height}=photoDimensions(photo.data,ext);
      if(photo.data.length<1500 || Math.max(width,height)<800 || Math.min(width,height)<400 || Math.max(width,height)/Math.min(width,height)>4) continue;
      const path = `${input.destination}/fotos/operador/imagen-${i + 1}.${ext}`;
      await files.write(path, photo.data); saved.push(path);
      photoDetails.push({path,url:photo.url.href,width,height,bytes:photo.data.length});
    } catch (e) { warnings.push(`No se guardó la foto ${i + 1}: ${String(e)}`); }
  }
  if (photos.length > 12) warnings.push('Se guardan como máximo 12 fotos por página.');
  const photoSummary=saved.length ? `Guardé ${saved.length} fotos de contenido; revisá sus dimensiones y elegí las que sirven.` : 'No encontré fotos útiles del contenido. Pedile fotos del destino o del hotel a la usuaria.';
  return { source, lines: text.split('\n').length, photos: saved, photoDetails, photoSummary, warnings, preview: lines.slice(0, 8) };
}
