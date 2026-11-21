import { readdir, mkdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgencyFiles } from './paths';

/** The travel kit bundled with the app. */
export const KIT_SOURCE = fileURLToPath(new URL('../../../kit/turismo/', import.meta.url));

function alreadyExists(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Refresh managed skills, or only add missing files in an existing agency. */
async function refreshKitSkills(
  target: AgencyFiles,
  kitSource: string,
  managed: boolean,
): Promise<void> {
  const source = new AgencyFiles(join(kitSource, '.agents', 'skills'));
  async function copy(dir: string) {
    for (const item of await readdir(await source.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isDirectory()) {
        await copy(path);
        continue;
      }
      const destination = `.agents/skills/${path}`;
      const bytes = await source.readBuffer(path);
      try {
        const existing = await target.readBuffer(destination);
        if (!managed || existing.equals(bytes)) continue;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      try { await target.write(destination, bytes, !managed); }
      catch (error) { if (managed || !alreadyExists(error)) throw error; }
    }
  }
  await copy('.');
}

async function kitState(state: AgencyFiles, marker: string, root: string, identity: string) {
  try {
    const saved: unknown = JSON.parse(await state.read(marker));
    if (!saved || typeof saved !== 'object' || !('workspace' in saved) ||
        typeof saved.workspace !== 'string' || !isAbsolute(saved.workspace) || relative(saved.workspace, root)) return;
    if ('version' in saved && saved.version === 1) return 'legacy';
    if (!('identity' in saved) || saved.identity !== identity) return;
    if ('status' in saved && (saved.status === 'copying' || saved.status === 'ready' || saved.status === 'add-only')) return saved.status;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export async function initializeKit(
  workspace: string,
  data: string,
  kitSource = KIT_SOURCE,
): Promise<{ skillsError?: string }> {
  await mkdir(workspace, { recursive: true });
  await mkdir(data, { recursive: true });
  const root = await realpath(workspace);
  const { birthtimeNs, ino } = await stat(root, { bigint: true });
  const identity = `${birthtimeNs}:${ino}`;
  const source = new AgencyFiles(kitSource);
  const target = new AgencyFiles(root);
  const state = new AgencyFiles(data);
  const marker = `kit-initialized-${createHash('sha256').update(root.toLowerCase()).digest('hex')}.json`;
  const previous = await kitState(state, marker, root, identity);
  // A folder the kit set up that lost its AGENTS.md was emptied or moved
  // (#65): it gets the missing kit files back, without overwriting anything.
  const kitOwned = previous === 'ready' || previous === 'legacy';
  const lostRules = kitOwned && !(await readdir(root)).some(name => name.toLowerCase() === 'agents.md');
  const copyFullKit = (await readdir(root)).length === 0 || previous === 'copying' || lostRules;

  async function saveMarker(status: 'copying' | 'ready' | 'add-only') {
    await state.write(marker, JSON.stringify({ version: 2, workspace: root, identity, status }), false);
  }
  async function copy(dir: string) {
    for (const item of await readdir(await source.path(dir), { withFileTypes: true })) {
      const path = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (path === '.agents/skills') continue;
      if (item.isDirectory()) await copy(path);
      else try { await target.write(path, await source.readBuffer(path)); }
      catch (error) { if (!alreadyExists(error)) throw error; }
    }
  }

  // Only an empty folder, or the same folder after a partial kit copy, gets
  // the full kit. A replaced folder at the same path gets classified afresh.
  if (copyFullKit) {
    await saveMarker('copying');
    await copy('.');
  } else if (previous === 'legacy') {
    await saveMarker('ready');
  }
  try {
    await refreshKitSkills(target, kitSource, !copyFullKit && kitOwned);
    if (copyFullKit) await saveMarker(previous === 'copying' ? 'add-only' : 'ready');
    return {};
  } catch (error) {
    return { skillsError: String(error) };
  }
}
