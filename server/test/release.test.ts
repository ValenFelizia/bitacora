import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { makeManifest, releaseHead, verifyBuildInfo, verifyInstaller, verifyReleaseVersion } from "../../scripts/release.mjs";

test("latest.json points to the versioned setup and contains the signature for its architecture", () => {
  assert.deepEqual(makeManifest({
    version: "0.2.1",
    notes: "Mejoras en Bitácora.",
    date: new Date("2026-11-26T12:00:00.000Z"),
    arch: "x64",
    installer: "Bitacora_0.2.1_x64-setup.exe",
    signature: "test-signature\r\n",
  }), {
    version: "0.2.1",
    notes: "Mejoras en Bitácora.",
    pub_date: "2026-11-26T12:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/ValenFelizia/bitacora/releases/download/v0.2.1/Bitacora_0.2.1_x64-setup.exe",
        signature: "test-signature",
      },
    },
  });
});

async function fixture() {
  await mkdir(".local", { recursive: true });
  return mkdtemp(resolve(".local/release-test-"));
}

test("build preflight requires a clean Git commit with matching npm and Cargo versions", async () => {
  const root = await fixture();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    for (const dir of ["server", "web", "src-tauri"]) await mkdir(join(root, dir));
    const version = "0.2.1";
    for (const file of ["package.json", "server/package.json", "web/package.json", "src-tauri/tauri.conf.json"])
      await writeFile(join(root, file), JSON.stringify({ version }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      version, packages: { "": { version }, server: { version }, web: { version } },
    }));
    await writeFile(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "bitacora"\nversion = "0.2.1"\n');
    const cargoLock = join(root, "src-tauri/Cargo.lock");
    await writeFile(cargoLock, '[[package]]\nname = "bitacora"\nversion = "0.2.0"\n');
    git("init", "-q");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release-test@example.com");
    git("add", ".");
    git("commit", "-qm", "Old Cargo lock");
    await assert.rejects(releaseHead(root, version), /Cargo\.lock/);
    await writeFile(cargoLock, '[[package]]\nname = "bitacora"\nversion = "0.2.1"\n');
    await assert.rejects(releaseHead(root, version), /Guardá los cambios/);
    git("add", ".");
    git("commit", "-qm", "Update Cargo lock");
    assert.equal(await releaseHead(root, version), git("rev-parse", "HEAD"));
    await writeFile(join(root, "untracked.txt"), "changes");
    await assert.rejects(releaseHead(root, version), /Guardá los cambios/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("publishing requires the build's version, HEAD and installer hash", () => {
  const expected = { version: "0.2.1", head: "head", sha256: "hash" };
  const info = { version: "0.2.1", commit: "head", sha256: "hash" };
  verifyBuildInfo(info, expected);
  for (const mismatch of [{ version: "0.2.0" }, { commit: "old" }, { sha256: "changed" }])
    assert.throws(() => verifyBuildInfo({ ...info, ...mismatch }, expected), /no coincide/);
});

test("publishing advances the version numerically across published releases", () => {
  const releases = [
    { tag_name: "v0.2.9", draft: false },
    { tag_name: "v0.2.10", draft: false },
    { tag_name: "v0.2.11-rc.1", draft: false },
    { tag_name: "v0.3.0", draft: true },
  ];
  for (const version of ["0.2.9", "0.2.10"]) assert.throws(() => verifyReleaseVersion(version, releases), /posterior/);
  verifyReleaseVersion("0.2.11", releases);
  verifyReleaseVersion("0.2.1", []);
});

test("verifies a versioned installer signed by Tauri with a password-protected test key", async () => {
  const root = await fixture();
  const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
  const signer = (...args: string[]) => execFileSync(process.execPath, [cli, "signer", ...args], { cwd: root, stdio: "pipe" });
  try {
    const installer = join(root, "fixture.exe");
    const key = join(root, "private");
    const wrong = join(root, "wrong");
    const password = "disposable-for-test";
    signer("generate", "--ci", "--password", password, "--write-keys", key);
    signer("generate", "--ci", "--password", password, "--write-keys", wrong);
    const artifact = "synthetic installer";
    await writeFile(installer, artifact);
    signer("sign", "--private-key-path", key, "--password", password, "--app-version", "0.2.1", installer);
    const [signature, pubkey, wrongKey] = await Promise.all(
      [installer + ".sig", key + ".pub", wrong + ".pub"].map((path) => readFile(path, "utf8")),
    );
    const sha256 = await verifyInstaller(installer, signature, pubkey.trim(), "0.2.1");
    assert.equal(sha256, createHash("sha256").update(artifact).digest("hex"));
    await assert.rejects(verifyInstaller(installer, signature, wrongKey.trim(), "0.2.1"), /clave pública/);
    await assert.rejects(verifyInstaller(installer, signature, pubkey.trim(), "0.2.2"), /firma no acredita/);
    const raw = Buffer.from(signature, "base64").toString("utf8");
    const editedComment = Buffer.from(raw.replace("version:0.2.1", "version:0.2.2")).toString("base64");
    await assert.rejects(verifyInstaller(installer, editedComment, pubkey.trim(), "0.2.2"), /firma.*no es válida/);
    await writeFile(installer, "tampered artifact");
    await assert.rejects(verifyInstaller(installer, signature, pubkey.trim(), "0.2.1"), /firma.*no es válida/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
