import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
export function paths(env = process.env) {
  const data = resolve(env.BITACORA_DATA_DIR || join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Bitacora'));
  const workspace = resolve(env.BITACORA_WORKSPACE || join(homedir(), 'Bitacora'));
  const codexHome = join(data, 'codex');
  const inside = (root: string, target: string) => { const r = relative(root, target); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
  if (inside(workspace, data) || inside(data, workspace)) throw new Error('La carpeta de trabajo y los datos de Bitácora deben estar separados.');
  return { data, workspace, codexHome };
}
