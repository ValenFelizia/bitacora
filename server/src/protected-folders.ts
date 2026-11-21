import koffi from "koffi";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * A folder the agent must never get to write in. `rootOnly` refuses the folder
 * and the folders that contain it, but allows the folders inside it.
 */
export type ProtectedFolder = { path: string; problem: string; rootOnly?: boolean };

const shell = koffi.load("shell32.dll");
const folderPath = shell.func("long __stdcall SHGetFolderPathW(void *, int, void *, uint32, void *)");

function knownFolder(id: number) {
  const path = Buffer.alloc(260 * 2);
  // CSIDL_FLAG_DONT_VERIFY also returns the location before it is created.
  if (folderPath(null, id | 0x4000, null, 0, path) !== 0) return undefined;
  return path.toString("utf16le").split("\0", 1)[0];
}

/**
 * Where a working folder would let the agent escape its write protection: the
 * app's own files and Codex, the folders other programs and Windows run code
 * from, and folders so wide that they contain all of those. The first match
 * gives the message, so the most specific reason comes first.
 */
export function protectedWorkspaceFolders(appPaths: string[]): ProtectedFolder[] {
  const env = process.env;
  const profile = homedir();
  const appData = join(profile, "AppData");
  const local = env.LOCALAPPDATA || join(appData, "Local");
  const roaming = env.APPDATA || join(appData, "Roaming");
  const list: ProtectedFolder[] = [];
  function protect(paths: (string | undefined)[], problem: string, rootOnly = false) {
    for (const path of paths) if (path && isAbsolute(path)) list.push({ path, problem, rootOnly });
  }
  protect([...appPaths, dirname(process.execPath), join(local, "Bitácora"), join(local, "Bitacora")],
    "Esa carpeta forma parte de la instalación de Bitácora o la incluye. Elegí otra.");
  protect([
    knownFolder(7), knownFolder(24), // CSIDL_STARTUP, CSIDL_COMMON_STARTUP
    join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    env.ProgramData && join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
  ], "Windows usa esa carpeta para arrancar programas. Elegí otra.");
  // Programs installed for one account live here too (and folders on the
  // program search path), so nothing inside is a working folder.
  protect([local, roaming, appData], "Windows y otras aplicaciones guardan datos en esa carpeta. Elegí otra.");
  protect([env.SystemRoot || env.WINDIR || "C:\\Windows", env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.ProgramData],
    "Windows usa esa carpeta o guarda programas ahí. Elegí otra.");
  protect([profile], "Elegí una carpeta dentro de tu cuenta. La carpeta de tu cuenta entera es demasiado amplia.", true);
  return list;
}
