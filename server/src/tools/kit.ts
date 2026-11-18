import { readdir, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgencyFiles } from './paths';

export async function initializeKit(
  workspace: string,
  data: string,
  kitSource = fileURLToPath(new URL('../../../kit/turismo/', import.meta.url)),
) {
  await mkdir(workspace, {recursive:true});
  await mkdir(data,{recursive:true});
  const source = new AgencyFiles(kitSource);
  const target = new AgencyFiles(workspace);
  const state = new AgencyFiles(data);
  const marker = `kit-initialized-${createHash('sha256').update((await realpath(workspace)).toLowerCase()).digest('hex')}.json`;
  try { await state.read(marker); return; }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  async function copy(dir: string) {
    for (const item of await readdir(await source.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) await copy(path);
      else try { await target.write(path, await source.readBuffer(path)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  }
  await copy('.');
  await state.write(marker, JSON.stringify({version:1,workspace:await realpath(workspace)}));
}
