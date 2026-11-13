import { readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgencyFiles } from './paths';

export async function initializeKit(workspace: string) {
  await mkdir(workspace, {recursive:true});
  const source = new AgencyFiles(fileURLToPath(new URL('../../../kit/turismo/', import.meta.url)));
  const target = new AgencyFiles(workspace);
  try { await target.read('.bitacora-kit-initialized'); return; }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  async function copy(dir: string) {
    for (const item of await readdir(await source.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) await copy(path);
      else try { await target.write(path, await source.read(path)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  }
  await copy('.');
  await target.write('.bitacora-kit-initialized', '1\n');
}
