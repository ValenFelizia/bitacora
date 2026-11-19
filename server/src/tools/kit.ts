import { readdir, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgencyFiles } from './paths';

/** The travel kit bundled with the app. */
export const KIT_SOURCE = fileURLToPath(new URL('../../../kit/turismo/', import.meta.url));

/**
 * Whether the agency already has exactly these bytes. A normal start finds the
 * same files and writes nothing, so a read-only or busy file cannot fail a
 * start that had nothing to change.
 */
async function sameBytes(files: AgencyFiles, path: string, expected: Buffer): Promise<boolean> {
  try { return (await files.readBuffer(path)).equals(expected); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * Copies the kit's own skills into an agency on every start. Codex only finds
 * them as `repo` scope under `<agency>/.agents/skills/<name>/SKILL.md`, and an
 * agency initialized before the kit shipped skills has none. Only that folder
 * is written, only when the bytes differ, and everything else the agency edited
 * stays as it is.
 *
 * A kit without its skills is a packaging error: it throws instead of starting
 * without them. The caller turns that into a notice (DEC-011).
 */
export async function refreshKitSkills(
  workspace: string,
  kitSource = KIT_SOURCE,
): Promise<void> {
  const sourceRoot = new AgencyFiles(join(kitSource, '.agents', 'skills'));
  const target = new AgencyFiles(workspace);
  async function copy(dir: string) {
    for (const item of await readdir(await sourceRoot.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) await copy(path);
      else {
        const bytes = await sourceRoot.readBuffer(path);
        const destination = `.agents/skills/${path}`;
        if (await sameBytes(target, destination, bytes)) continue;
        // Replaced when it differs: a skill is the kit's, and the allowlist
        // expects the exact name at the exact path on every start.
        await target.write(destination, bytes, false);
      }
    }
  }
  await copy('.');
}

export async function initializeKit(
  workspace: string,
  data: string,
  kitSource = KIT_SOURCE,
): Promise<{ skillsError?: string }> {
  await mkdir(workspace, {recursive:true});
  await mkdir(data,{recursive:true});
  let skillsError: string | undefined;
  try { await refreshKitSkills(workspace, kitSource); }
  catch (error) { skillsError = String(error); }
  const source = new AgencyFiles(kitSource);
  const target = new AgencyFiles(workspace);
  const state = new AgencyFiles(data);
  const marker = `kit-initialized-${createHash('sha256').update((await realpath(workspace)).toLowerCase()).digest('hex')}.json`;
  try { await state.read(marker); return { skillsError }; }
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
  return { skillsError };
}
