import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "ValenFelizia/bitacora";
const configPath = "src-tauri/tauri.conf.json";
const cargoPath = "src-tauri/Cargo.toml";
const cargoLockPath = "src-tauri/Cargo.lock";
const bitacoraLockVersion = /^(\[\[package\]\]\r?\nname = "bitacora"\r?\nversion = ")[^"]+(")/m;
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
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

function run(program, args, env = process.env) {
  execFileSync(program, args, { cwd: root, stdio: "inherit", env });
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function releaseHead(cwd, version) {
  if (git(cwd, "status", "--porcelain", "--untracked-files=all"))
    throw new Error("Guardá los cambios en Git antes de armar o publicar.");
  const head = git(cwd, "rev-parse", "HEAD");
  const committed = (path) => git(cwd, "show", head + ":" + path);
  const lock = JSON.parse(committed("package-lock.json"));
  const cargo = parse(committed(cargoPath));
  const cargoLock = parse(committed(cargoLockPath));
  const versions = [
    ...versionFiles.map((path) => [JSON.parse(committed(path)).version, path]),
    [lock.version, "package-lock.json"],
    ...["", "server", "web"].map((workspace) => [lock.packages[workspace]?.version, "package-lock.json"]),
    [cargo.package?.version, cargoPath],
    [cargoLock.package?.find((pkg) => pkg.name === "bitacora" && !pkg.source)?.version, cargoLockPath],
  ];
  const mismatched = new Set(versions.filter(([found]) => found !== version).map(([, path]) => path));
  if (mismatched.size)
    throw new Error(`Guardá la versión ${version} en Git antes de seguir. Falta en: ${[...mismatched].join(", ")}.`);
  return head;
}

async function bumpVersion(version) {
  for (const path of versionFiles) {
    const config = await readJson(path);
    config.version = version;
    await writeFile(join(root, path), JSON.stringify(config, null, 2) + "\n");
  }
  for (const [path, pattern] of [[cargoPath, cargoVersion], [cargoLockPath, bitacoraLockVersion]]) {
    const content = await readFile(join(root, path), "utf8");
    if (!pattern.test(content)) throw new Error(`No encontré la versión en ${path}.`);
    await writeFile(join(root, path), content.replace(pattern, (_, prefix, suffix) => prefix + version + suffix));
  }
  // Keep the resolved dependency graphs intact.
  const lock = await readJson("package-lock.json");
  lock.version = version;
  for (const workspace of ["", "server", "web"]) lock.packages[workspace].version = version;
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
}

function decodeBase64(value) {
  const decoded = Buffer.from(value ?? "", "base64");
  if (!value || decoded.toString("base64") !== value)
    throw new Error("La clave pública o la firma tienen un formato inválido.");
  return decoded;
}

// Tauri wraps the Minisign text files in base64. Its signer uses Ed25519
// over a BLAKE2b-512 digest, and also signs the signature plus trusted comment.
export async function verifyInstaller(installer, signature, publicKey, version) {
  const [, encodedKey] = decodeBase64(publicKey).toString("utf8").split(/\r?\n/);
  const [, encodedSignature, trustedComment, encodedGlobal] =
    decodeBase64(signature.trim()).toString("utf8").split(/\r?\n/);
  const key = decodeBase64(encodedKey);
  const signed = decodeBase64(encodedSignature);
  const global = decodeBase64(encodedGlobal);
  const prefix = "trusted comment: ";
  if (key.length !== 42 || !["Ed", "ED"].includes(key.toString("ascii", 0, 2)) ||
      signed.length !== 74 || signed.toString("ascii", 0, 2) !== "ED" ||
      global.length !== 64 || !trustedComment?.startsWith(prefix) ||
      !key.subarray(2, 10).equals(signed.subarray(2, 10)))
    throw new Error("La firma no corresponde a la clave pública del actualizador.");
  const comment = trustedComment.slice(prefix.length);
  const publicEd25519 = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    type: "spki", format: "der",
  });
  const artifactSignature = signed.subarray(10);
  if (!verify(null, Buffer.concat([artifactSignature, Buffer.from(comment)]), publicEd25519, global))
    throw new Error("La firma del instalador no es válida.");
  const signedVersion = comment.split("\t").find((field) => field.startsWith("version:"));
  if (signedVersion !== `version:${version}` && signedVersion !== `version:v${version}`)
    throw new Error(`La firma no acredita la versión ${version}.`);
  const blake = createHash("blake2b512");
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(installer)) {
    blake.update(chunk);
    sha.update(chunk);
  }
  if (!verify(null, blake.digest(), publicEd25519, artifactSignature))
    throw new Error("La firma del instalador no es válida.");
  return sha.digest("hex");
}

export function verifyBuildInfo(info, { version, head, sha256 }) {
  if (info?.version !== version || info?.commit !== head || info?.sha256 !== sha256)
    throw new Error("El instalador no coincide con este commit. Volvé a armarlo antes de publicar.");
}

export function verifyReleaseVersion(version, releases) {
  const parts = version.split(".").map(BigInt);
  for (const { draft, tag_name: tag } of releases) {
    if (draft) continue;
    const published = tag.replace(/^v/, "").split("+", 1)[0];
    const [core, prerelease] = published.split("-", 2);
    if (!stableVersion.test(core)) continue;
    const publishedParts = core.split(".").map(BigInt);
    const different = parts.findIndex((part, i) => part !== publishedParts[i]);
    if (different === -1 ? !prerelease : parts[different] < publishedParts[different])
      throw new Error(`La versión ${version} tiene que ser posterior a la publicada (${tag}).`);
  }
}

async function build(version, arch, notes, files) {
  const head = await releaseHead(root, version);
  const signingKey = join(homedir(), ".tauri", "bitacora-updater.key");
  await access(signingKey);
  const config = await readJson(configPath);
  const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const built = join(bundle, `${config.productName}_${version}_${arch}-setup.exe`);
  await mkdir(files.directory, { recursive: true });
  // Invalidate the manifest before replacing any of its assets.
  await Promise.all([files.manifest, files.info, built, built + ".sig"].map((path) => rm(path, { force: true })));
  const signedConfig = join(files.directory, "signed-config.json");
  await writeFile(signedConfig, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
  run(process.execPath, [process.env.npm_execpath, "run", "build:installer", "--", "--config", signedConfig], {
    ...process.env,
    // The secret stays in the environment and never becomes an argument.
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  });
  if (await releaseHead(root, version) !== head)
    throw new Error("El commit cambió durante el armado. Volvé a armar la versión.");
  await copyFile(built, files.installer);
  await copyFile(`${built}.sig`, files.signature);
  const signature = await readFile(files.signature, "utf8");
  const sha256 = await verifyInstaller(files.installer, signature, config.plugins.updater.pubkey, version);
  await writeFile(files.info, JSON.stringify({ version, commit: head, sha256 }, null, 2) + "\n");
  const manifest = makeManifest({ version, notes, date: new Date(), arch, installer: files.name, signature });
  const temporaryManifest = files.manifest + ".tmp";
  await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n");
  await rename(temporaryManifest, files.manifest);
  console.log(`Instalador, firma, latest.json y build-info.json listos en ${files.directory}`);
}

export async function verifyReleaseFiles({ version, arch, head, files, publicKey }) {
  const manifest = await readJson(files.manifest);
  const signature = await readFile(files.signature, "utf8");
  const expected = makeManifest({
    version, notes: manifest.notes, date: new Date(manifest.pub_date),
    arch, installer: files.name, signature,
  });
  if (typeof manifest.notes !== "string" || JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error("Volvé a armar los archivos de esta versión antes de publicar.");
  const sha256 = await verifyInstaller(files.installer, signature, publicKey, version);
  verifyBuildInfo(await readJson(files.info), { version, head, sha256 });
  return manifest.notes;
}

async function publish(version, arch, files) {
  const head = await releaseHead(root, version);
  const remote = git(root, "ls-remote", "https://github.com/" + repository + ".git", "refs/heads/main");
  if (remote.split(/\s/)[0] !== head)
    throw new Error("Actualizá la copia local al último commit de main antes de publicar.");
  const pages = execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
    cwd: root, encoding: "utf8",
  });
  verifyReleaseVersion(version, JSON.parse(pages).flat());
  const config = await readJson(configPath);
  const notes = await verifyReleaseFiles({ version, arch, head, files, publicKey: config.plugins.updater.pubkey });
  await writeFile(files.notes, notes + "\n");
  if (await releaseHead(root, version) !== head)
    throw new Error("El commit cambió mientras revisaba el instalador.");
  run("gh", ["release", "create", `v${version}`, files.installer, files.signature, files.manifest,
    "--repo", repository, "--target", head, "--latest", "--title", `Bitácora ${version}`,
    "--notes-file", files.notes]);
}

async function main() {
  const [action, version, ...args] = process.argv.slice(2);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch) || !process.env.npm_execpath)
    throw new Error("Corré npm run release en Windows.");
  if (!["version", "build", "publish", "release"].includes(action) || !stableVersion.test(version || "") ||
      (args.length && (!["build", "release"].includes(action) || args.length !== 2 || args[0] !== "--notes-file")))
    throw new Error("Uso: npm run release -- <version|build|publish|release> <versión> [--notes-file <ruta>]");
  if (action === "version") {
    await bumpVersion(version);
    return;
  }
  const directory = join(root, ".local", "release", version);
  // GitHub can normalize uploaded names. The stable ASCII name also matches
  // the manifest on every host, regardless of the product's display name.
  const name = `Bitacora_${version}_${arch}-setup.exe`;
  const files = {
    directory, name, installer: join(directory, name), signature: join(directory, name + ".sig"),
    manifest: join(directory, "latest.json"), info: join(directory, "build-info.json"), notes: join(directory, "notes.md"),
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
