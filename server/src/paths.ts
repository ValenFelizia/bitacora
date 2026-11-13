import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { dirname, basename } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';

async function actualPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch(e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw e;
    return join(await actualPath(dirname(path)),basename(path));
  }
}
export async function preparePaths(locations: ReturnType<typeof paths>) {
  const separated = (workspace: string, data: string) => {
    const inside = (a:string,b:string) => { const r=relative(a,b); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
    if (inside(workspace,data) || inside(data,workspace)) throw new Error('La carpeta de trabajo y los datos de Bitácora deben estar separados también en el disco.');
  };
  separated(await actualPath(locations.workspace),await actualPath(locations.data));
  await mkdir(locations.workspace,{recursive:true}); await mkdir(locations.data,{recursive:true});
  const workspace = await realpath(locations.workspace), data = await realpath(locations.data);
  separated(workspace,data);
  return {workspace,data,codexHome:join(data,'codex')};
}
export function paths(env = process.env) {
  const data = resolve(
    env.BITACORA_DATA_DIR ||
      join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Bitacora"),
  );
  const workspace = resolve(
    env.BITACORA_WORKSPACE || join(homedir(), "Bitacora"),
  );
  const codexHome = join(data, "codex");
  const inside = (root: string, target: string) => {
    const r = relative(root, target);
    return !r || (!r.startsWith("..") && !isAbsolute(r));
  };
  if (inside(workspace, data) || inside(data, workspace))
    throw new Error(
      "La carpeta de trabajo y los datos de Bitácora deben estar separados.",
    );
  return { data, workspace, codexHome };
}
