import { lookup } from 'node:dns/promises';
import { request, Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import { AgencyFiles } from './paths';

export function publicAddress(address: string) {
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}
// Only test callers can grant one exact loopback origin. Never exposed by MCP.
export async function download(url: URL, signal: AbortSignal, testOrigin?: string, maxBytes = 5_000_000): Promise<{ data: Buffer; type: string; url: URL }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('La dirección debe ser http o https, sin credenciales.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address)) && url.origin !== testOrigin) throw new Error('No se permiten direcciones locales ni privadas.');
  const selected = addresses[0];
  // Pin the validated DNS answer to the connection: no second DNS lookup/rebinding.
  const dispatcher = new Agent({ connect: { lookup: (_host, _options, cb) => cb(null, selected.address, selected.family) } });
  try {
    const response = await request(url, { dispatcher, signal, headersTimeout: 15000, bodyTimeout: 15000 });
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
  } finally { await dispatcher.close(); }
}
async function follow(url: URL, signal: AbortSignal, testOrigin?: string, maxBytes?: number) {
  for (let i = 0; i < 6; i++) {
    try { return await download(url, signal, testOrigin, maxBytes); }
    catch (e) { if (!(e as {redirect?: URL}).redirect) throw e; url = (e as unknown as {redirect: URL}).redirect; }
  }
  throw new Error('Demasiadas redirecciones.');
}
export async function traer(files: AgencyFiles, input: { url?: string; destination: string; notes?: string }, testOrigin?: string) {
  const source = `${input.destination}/fuente.md`;
  if (!input.url) {
    if (!input.notes?.trim()) throw new Error('Falta la dirección o los datos para agregar.');
    const old = await files.read(source);
    await files.write(source, old + `\n## Datos aportados por la usuaria — ${new Date().toISOString()}\n${input.notes}\n`, false);
    return { source, lines: (await files.read(source)).split('\n').length };
  }
  const signal = AbortSignal.timeout(45000);
  const page = await follow(new URL(input.url), signal, testOrigin, 2_000_000);
  if (!/text\/html/i.test(page.type)) throw new Error('La dirección no devuelve una página HTML.');
  const $ = load(page.data.toString('utf8'));
  const photos = [...new Set($('img').toArray().map(el => $(el).attr('src') || $(el).attr('data-src')).filter((s): s is string => !!s))];
  $('script,style,noscript,svg,nav,footer').remove();
  $('td,th').append(' | '); $('p,div,tr,li,h1,h2,h3,h4,section,br').prepend('\n');
  const lines = $('body').text().split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = `# Fuente\nURL: ${page.url.href}\nConsultada: ${new Date().toISOString()}\n\n${lines.join('\n')}\n` + (input.notes ? `\n## Datos aportados por la usuaria — ${new Date().toISOString()}\n${input.notes}\n` : '');
  await files.write(source, text);
  const saved: string[] = [], warnings: string[] = [];
  for (const [i, src] of photos.slice(0, 12).entries()) {
    try {
      const photo = await follow(new URL(src, page.url), signal, testOrigin);
      const ext = /image\/jpeg/i.test(photo.type) ? 'jpg' : /image\/png/i.test(photo.type) ? 'png' : /image\/webp/i.test(photo.type) ? 'webp' : undefined;
      if (!ext) throw new Error('Formato de foto no admitido.');
      const path = `${input.destination}/fotos/operador-${i + 1}.${ext}`;
      await files.write(path, photo.data); saved.push(path);
    } catch (e) { warnings.push(`No se guardó la foto ${i + 1}: ${String(e)}`); }
  }
  if (photos.length > 12) warnings.push('Se guardan como máximo 12 fotos por página.');
  return { source, lines: text.split('\n').length, photos: saved, warnings, preview: lines.slice(0, 8) };
}
