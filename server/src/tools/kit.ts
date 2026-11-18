import { readdir, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgencyFiles } from './paths';

/** The travel kit bundled with the app. */
export const KIT_SOURCE = fileURLToPath(new URL('../../../kit/turismo/', import.meta.url));

/**
 * Copies the kit's own skills into an agency on every start. Codex only finds
 * them as `repo` scope under `<agency>/.agents/skills/<name>/SKILL.md`, and an
 * agency initialized before the kit shipped skills has none. Only that folder
 * is written, so everything else the agency edited stays as it is; the skills
 * themselves are the kit's and are refreshed from the app.
 */
export async function refreshKitSkills(
  workspace: string,
  kitSource = KIT_SOURCE,
) {
  const sourceRoot = new AgencyFiles(join(kitSource, '.agents', 'skills'));
  const target = new AgencyFiles(workspace);
  async function copy(dir: string) {
    for (const item of await readdir(await sourceRoot.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) await copy(path);
      // Overwritten on purpose: a skill is the kit's, and the allowlist expects
      // the exact name at the exact path on every start.
      else await target.write(`.agents/skills/${path}`, await sourceRoot.readBuffer(path), false);
    }
  }
  try { await copy('.'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}

export async function initializeKit(
  workspace: string,
  data: string,
  kitSource = KIT_SOURCE,
) {
  await mkdir(workspace, {recursive:true});
  await mkdir(data,{recursive:true});
  await refreshKitSkills(workspace, kitSource);
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
