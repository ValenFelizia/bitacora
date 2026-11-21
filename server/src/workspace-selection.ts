import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { checkWorkspaceSeparation, WorkspaceOverlap } from "./paths";
import { checkDirectoryWritable } from "./tools/directory-lock";

export type WorkspaceChoice = { root: string; data: string; key?: string };
export class WorkspaceProblem extends Error {}

export class WorkspaceSelection {
  readonly defaultChoice: WorkspaceChoice;
  private readonly preference: string;

  constructor(root: string, readonly data: string) {
    this.defaultChoice = { root, data };
    this.preference = join(data, "working-folder.json");
  }

  async validate(input: unknown): Promise<WorkspaceChoice> {
    if (typeof input !== "string" || !isAbsolute(input) || input.includes("\0"))
      throw new WorkspaceProblem("Elegí una carpeta que exista en tu compu.");

    try {
      const root = await realpath(input);
      checkWorkspaceSeparation(root, await realpath(this.data));
      await readdir(root);
      checkDirectoryWritable(root);
      if (!relative(this.defaultChoice.root, root)) return this.defaultChoice;
      const key = createHash("sha256").update(root.toLowerCase()).digest("hex");
      return { root, data: join(this.data, "workspaces", key), key };
    } catch (error) {
      if (error instanceof WorkspaceOverlap)
        throw new WorkspaceProblem("Esa carpeta incluye los datos de Bitácora o está dentro de ellos. Elegí otra.");
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))
        throw new WorkspaceProblem("No encontré esa carpeta. Elegí otra.");
      throw new WorkspaceProblem("No puedo guardar archivos en esa carpeta. Elegí otra.");
    }
  }

  async load(): Promise<{ choice: WorkspaceChoice; notice?: string }> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.preference, "utf8"));
      return { choice: await this.validate(stored) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { choice: this.defaultChoice };
      return {
        choice: this.defaultChoice,
        notice: "No pude abrir la última carpeta de trabajo. Abrí la de siempre. Podés elegir otra.",
      };
    }
  }

  async save(choice: WorkspaceChoice): Promise<void> {
    const temporary = `${this.preference}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(choice.root), { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.preference);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
