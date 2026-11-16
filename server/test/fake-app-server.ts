import { resolve } from "node:path";
import { appServerArgs, type SandboxBackend } from "../src/codex/engine";

/**
 * Arguments for the deterministic app-server peer (`stdio-server.mjs`), with
 * the ones the real app-server would get for the decided backend.
 *
 * The engine reads the mode back from the arguments it spawned, so a fake
 * started with fixed arguments is a process the check would replace: every
 * caller that fakes the app-server has to pass the backend through.
 */
export function fakeAppServerArgs(backend: SandboxBackend | undefined) {
  return [resolve("server/test/stdio-server.mjs"), ...appServerArgs(backend)];
}
