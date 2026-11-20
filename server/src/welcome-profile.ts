import { mkdir } from "node:fs/promises";
import { AgencyFiles } from "./tools/paths";
import { PROFILE_FILE, parseProfile, profileMarkdown, type WelcomeAnswers, type WelcomeProfile } from "./welcome";

/**
 * Writes `perfil.md` inside the agency folder. The folder is created when it
 * does not exist yet, which is what a first start before answering has: only
 * the folder, never the kit (issue #65 keeps that).
 *
 * This module is the half of the welcome that touches disk; the questions and
 * the copy live in `welcome.ts`, which the screen also imports.
 */
export async function saveWelcomeProfile(workspace: string, answers: WelcomeAnswers): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await new AgencyFiles(workspace).write(PROFILE_FILE, profileMarkdown(answers), false);
}

/** The saved profile, or nothing when the welcome was skipped or the file is gone. */
export async function readWelcomeProfile(workspace: string): Promise<WelcomeProfile> {
  try {
    return parseProfile(await new AgencyFiles(workspace).read(PROFILE_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { uses: [] };
    throw error;
  }
}
