import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const allowedUrlsPath = (data: string) => join(data, 'allowed-urls.json');
export function extractUserUrls(text: string) {
  return (text.match(/(?:https?:\/\/|www\.)[^\s<>"'`«»“”‘’]+/gi) || []).flatMap(raw => {
    let value = raw.replace(/[.,;!?]+$/, '');
    // Remove wrapping punctuation, preserving balanced parentheses inside paths.
    while (/[)\]}]$/.test(value)) {
      const end = value.at(-1)!;
      const start = ({')':'(',']':'[','}':'{'} as Record<string,string>)[end];
      if (value.split(end).length <= value.split(start).length) break;
      value = value.slice(0,-1).replace(/[.,;!?]+$/, '');
    }
    try { return [normalizeUrl(/^www\./i.test(value) ? `https://${value}` : value)]; } catch { return []; }
  });
}
export function normalizeUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Usá un link http o https sin credenciales.');
  url.hash = '';
  return url.href;
}
export async function readAllowedUrls(path: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new SyntaxError('No pude leer la lista de links permitidos.');
    try { return value.map(normalizeUrl); } catch { throw new SyntaxError('Hay un link dañado en la lista.'); }
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
// Only the app calls this writer, from the accepted user request, before engine.send.
export async function rememberUserUrls(data: string, text: string) {
  const urls = extractUserUrls(text);
  const path = allowedUrlsPath(data);
  let previous: string[];
  try { previous = await readAllowedUrls(path); }
  catch(e) {
    if (!(e instanceof SyntaxError)) throw e;
    await rename(path, `${path}.corrupt-${randomUUID()}`);
    previous = [];
  }
  if (!urls.length && previous.length) return;
  const entries = [...new Set([...previous, ...urls])];
  await mkdir(dirname(path), {recursive:true});
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(entries, null, 2), {encoding:'utf8',flag:'wx'});
  await rename(temp, path);
}
export async function requireAllowedUrl(path: string, value: string) {
  if (!(await readAllowedUrls(path)).includes(normalizeUrl(value))) throw new Error('Este link no fue escrito por la usuaria. Pedile que lo pegue en el próximo pedido.');
}
