import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "ValenFelizia/bitacora";
const configPath = "src-tauri/tauri.conf.json";
const cargoPath = "src-tauri/Cargo.toml";
const versionFiles = ["package.json", "server/package.json", "web/package.json", configPath];
const cargoVersion = /^(\[package\][^[]*?^version = ")[^"]+(")/m;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function makeManifest({ version, notes, date, arch, installer, signature }) {
  const updaterArch = arch === "x64" ? "x86_64" : "aarch64";
  return {
    version,
    notes,
    pub_date: date.toISOString(),
    platforms: {
      [`windows-${updaterArch}`]: {
        url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(installer)}`,
        signature: signature.trim(),
      },
    },
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

function run(program, args, env = process.env) {
  execFileSync(program, args, { cwd: root, stdio: "inherit", env });
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function bumpVersion(version) {
  for (const path of versionFiles) {
    const config = await readJson(path);
    config.version = version;
    await writeFile(join(root, path), JSON.stringify(config, null, 2) + "\n");
  }
  const path = join(root, cargoPath);
  const cargo = await readFile(path, "utf8");
  if (!cargoVersion.test(cargo)) throw new Error("No encontré la versión de Cargo.");
  await writeFile(path, cargo.replace(cargoVersion, (_, prefix, suffix) => prefix + version + suffix));
  // Only the workspace versions change. Keep npm's resolved dependency graph intact.
  const lock = await readJson("package-lock.json");
  lock.version = version;
  for (const workspace of ["", "server", "web"]) lock.packages[workspace].version = version;
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
}

async function build(version, arch, notes, files) {
  const signingKey = join(homedir(), ".tauri", "bitacora-updater.key");
  await access(signingKey);
  await bumpVersion(version);
  await mkdir(files.directory, { recursive: true });
  const signedConfig = join(files.directory, "signed-config.json");
  await writeFile(signedConfig, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
  run(process.execPath, [process.env.npm_execpath, "run", "build:installer", "--", "--config", signedConfig], {
    ...process.env,
    // Tauri reads the key from this path. The secret never becomes an argument
    // or a line of output from this script.
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  });
  const { productName } = await readJson(configPath);
  const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const built = join(bundle, `${productName}_${version}_${arch}-setup.exe`);
  const signature = await readFile(`${built}.sig`, "utf8");
  if (!signature.trim()) throw new Error("El instalador quedó sin firma.");
  // The manifest marks the bundle as ready. Invalidate it before replacing
  // the assets so publishing cannot pick up a partially written build.
  await rm(files.manifest, { force: true });
  await copyFile(built, files.installer);
  await copyFile(`${built}.sig`, files.signature);
  const manifest = makeManifest({
    version, notes, date: new Date(), arch, installer: files.name, signature,
  });
  const temporaryManifest = files.manifest + ".tmp";
  await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n");
  await rename(temporaryManifest, files.manifest);
  console.log(`Instalador, firma y latest.json listos en ${files.directory}`);
}

async function publish(version, arch, files) {
  const { version: configured } = await readJson(configPath);
  if (configured !== version || git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("Publicá desde el commit de la versión, con los cambios guardados en Git.");
  const head = git("rev-parse", "HEAD");
  const remote = git("ls-remote", "https://github.com/" + repository + ".git", "refs/heads/main");
  if (remote.split(/\s/)[0] !== head)
    throw new Error("Actualizá la copia local al último commit de main antes de publicar.");
  await access(files.installer);
  const manifest = await readJson(files.manifest);
  const expected = makeManifest({
    version, notes: manifest.notes, date: new Date(manifest.pub_date),
    arch, installer: files.name, signature: await readFile(files.signature, "utf8"),
  });
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error("Volvé a armar los archivos de esta versión antes de publicar.");
  await writeFile(files.notes, manifest.notes + "\n");
  run("gh", ["release", "create", `v${version}`, files.installer, files.signature, files.manifest,
    "--repo", repository, "--target", head, "--latest", "--title", `Bitácora ${version}`,
    "--notes-file", files.notes]);
}

async function main() {
  const [action, version, ...args] = process.argv.slice(2);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) || !process.env.npm_execpath)
    throw new Error("Corré npm run release en Windows.");
  if (!["build", "publish", "release"].includes(action) || !stableVersion.test(version || "") ||
      (args.length && (action === "publish" || args.length !== 2 || args[0] !== "--notes-file")))
    throw new Error("Uso: npm run release -- <build|publish|release> <versión> [--notes-file <ruta>]");
  const directory = join(root, ".local", "release", version);
  // GitHub can normalize uploaded names. The stable ASCII name also matches
  // the manifest on every host, regardless of the product's display name.
  const name = `Bitacora_${version}_${arch}-setup.exe`;
  const files = {
    directory, name, installer: join(directory, name), signature: join(directory, name + ".sig"),
    manifest: join(directory, "latest.json"), notes: join(directory, "notes.md"),
  };
  if (action !== "publish") {
    const notes = args.length ? (await readFile(args[1], "utf8")).trim() : `Actualización de Bitácora a ${version}.`;
    await build(version, arch, notes, files);
  }
  if (action !== "build") await publish(version, arch, files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
