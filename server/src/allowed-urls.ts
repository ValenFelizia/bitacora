import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const allowedUrlsPath = (data: string) => join(data, 'allowed-urls.json');
export function normalizeUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Usá un link http o https sin credenciales.');
  url.hash = '';
  return url.href;
}
export async function readAllowedUrls(path: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('No pude leer la lista de links permitidos.');
    return value.map(normalizeUrl);
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
// Only the app calls this writer, from the accepted user request, before engine.send.
export async function rememberUserUrls(data: string, text: string) {
  const urls = (text.match(/https?:\/\/[^\s<>"'`]+/gi) || []).flatMap(raw => {
    try { return [normalizeUrl(raw.replace(/[.,;!?)\]}]+$/, ''))]; } catch { return []; }
  });
  if (!urls.length) return;
  const path = allowedUrlsPath(data);
  const entries = [...new Set([...(await readAllowedUrls(path)), ...urls])];
  await mkdir(dirname(path), {recursive:true});
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(entries, null, 2), {encoding:'utf8',flag:'wx'});
  await rename(temp, path);
}
export async function requireAllowedUrl(path: string, value: string) {
  if (!(await readAllowedUrls(path)).includes(normalizeUrl(value))) throw new Error('Este link no fue escrito por la usuaria. Pedile que lo pegue en el próximo pedido.');
}
