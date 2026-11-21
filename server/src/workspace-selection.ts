import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { actualPath, checkWorkspaceSeparation, inside, WorkspaceOverlap } from "./paths";
import type { ProtectedFolder } from "./protected-folders";
import { checkDirectoryWritable } from "./tools/directory-lock";

export type WorkspaceChoice = { root: string; data: string; key?: string };
export class WorkspaceProblem extends Error {}
export const SAVED_FOLDER_UNAVAILABLE =
  "No pude abrir la última carpeta de trabajo. Abrí la de siempre. Podés elegir otra.";

export class WorkspaceSelection {
  readonly defaultChoice: WorkspaceChoice;
  private readonly preference: string;

  constructor(root: string, readonly data: string, private readonly protectedFolders: ProtectedFolder[] = []) {
    this.defaultChoice = { root, data };
    this.preference = join(data, "working-folder.json");
  }

  private async readPreference() {
    const stored: unknown = JSON.parse(await readFile(this.preference, "utf8"));
    if (typeof stored === "string") return { active: stored, known: [stored] };
    if (!stored || typeof stored !== "object" || !("active" in stored) || typeof stored.active !== "string" ||
        !("known" in stored) || !Array.isArray(stored.known) ||
        !stored.known.every((path): path is string => typeof path === "string" && isAbsolute(path)))
      throw new Error("Invalid workspace preference");
    return { active: stored.active, known: stored.known };
  }

  private async knownFolders() {
    return (await this.readPreference().catch(() => undefined))?.known ?? [];
  }

  /**
   * The agent may write anywhere in the folder it works in. A disk, a system
   * or program folder, the app's own files or a folder Windows runs programs
   * from would let it change what runs outside its protection.
   */
  async refuseProtected(root: string) {
    if (dirname(root) === root)
      throw new WorkspaceProblem("Elegí una carpeta dentro del disco. El disco entero es demasiado amplio.");
    const folders = await Promise.all(this.protectedFolders.map(async (folder) =>
      ({ ...folder, paths: [folder.path, await actualPath(folder.path).catch(() => folder.path)] })));
    // The folder itself, or one it is inside of, explains better than a
    // protected folder somewhere below it.
    const within = folders.find(({ paths, rootOnly }) =>
      paths.some(folder => rootOnly ? !relative(folder, root) : inside(folder, root)));
    const containing = folders.find(({ paths }) => paths.some(folder => inside(root, folder)));
    const problem = (within ?? containing)?.problem;
    if (problem) throw new WorkspaceProblem(problem);
  }

  async validate(input: unknown): Promise<WorkspaceChoice> {
    if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0"))
      throw new WorkspaceProblem("Elegí una carpeta que exista en tu compu.");

    try {
      const root = await realpath(input);
      await this.refuseProtected(root);
      checkWorkspaceSeparation(root, await realpath(this.data));
      for (const path of [this.defaultChoice.root, ...await this.knownFolders()]) {
        const canonical = await actualPath(path).catch(() => path);
        if (relative(canonical, root) && (inside(canonical, root) || inside(root, canonical)))
          throw new WorkspaceProblem("Esa carpeta queda dentro de otra carpeta de trabajo o la incluye. Elegí una carpeta aparte.");
      }
      await readdir(root);
      checkDirectoryWritable(root);
      if (!relative(this.defaultChoice.root, root)) return this.defaultChoice;
      const key = createHash("sha256").update(root.toLowerCase()).digest("hex");
      return { root, data: join(this.data, "workspaces", key), key };
    } catch (error) {
      if (error instanceof WorkspaceProblem) throw error;
      if (error instanceof WorkspaceOverlap)
        throw new WorkspaceProblem("Esa carpeta incluye los datos de Bitácora o está dentro de ellos. Elegí otra.");
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))
        throw new WorkspaceProblem("No encontré esa carpeta. Elegí otra.");
      throw new WorkspaceProblem("No puedo guardar archivos en esa carpeta. Elegí otra.");
    }
  }

  async load(): Promise<{ choice: WorkspaceChoice; notice?: string }> {
    try {
      const { active } = await this.readPreference();
      return { choice: await this.validate(active) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { choice: this.defaultChoice };
      return {
        choice: this.defaultChoice,
        notice: SAVED_FOLDER_UNAVAILABLE,
      };
    }
  }

  async save(choice: WorkspaceChoice): Promise<void> {
    const temporary = `${this.preference}.${randomUUID()}.tmp`;
    try {
      const known = [...new Set([...await this.knownFolders(), choice.root])];
      await writeFile(temporary, JSON.stringify({ active: choice.root, known }), { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.preference);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
