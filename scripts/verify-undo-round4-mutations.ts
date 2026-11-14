import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/undo-r4-mutants-'));
const source = await readFile('server/src/backups.ts', 'utf8');
const noLinks = (s: string) => s.replace(/\(await lstat\((target|path)\)\)\.isSymbolicLink\(\)/g, 'false');
const variants = [
  { name: 'remove explicit link checks', test: 'undo-round4', pattern: 'R4 Opus 4: an internal junction', mutate: noLinks },
  { name: 'remove explicit link and containment checks', test: 'undo-round4', pattern: 'R4 containment:', mutate: (s: string) => noLinks(s).replace(/!inside\(this\.root, (resolved|path|folder)\)/g, 'false').split('\n').map(line => line.includes('relative(this.root, resolved).split') ? "        if (false) throw new RestoreProblem(path, 'hay un enlace en el camino');" : line).join('\n') },
  { name: 'remove descendant later-change guard', test: 'undo-round3', pattern: 'N6 later edits in a directory-to-file', mutate: (s: string) => s.split('\n').filter(line => !line.includes("'hay cambios posteriores dentro de esa carpeta'")).join('\n') },
  { name: 'remove immediately-before-open route check', test: 'undo-round3', pattern: 'N5/N6 recheck immediately before write', mutate: (s: string) => s.replace('const initialFolder = await this.checkAbsolute(temporary);', 'const initialFolder = await realpath(dirname(temporary));') },
  { name: 'remove immediately-before-rename route checks', test: 'undo-round3', pattern: 'N5/N6 recheck immediately before rename', mutate: (s: string) => s.replace('const sourceParent = await this.checkAbsolute(from), targetParent = await this.checkAbsolute(to);', 'const sourceParent = dirname(from), targetParent = dirname(to);') },
];
const records: unknown[] = [];
try {
  for (const [i, variant] of variants.entries()) {
    const modulePath = join(base, `mutant-${i}.ts`), testPath = join(base, `case-${i}.test.ts`);
    let changed = variant.mutate(source); assert.notEqual(changed, source);
    for (const name of ['workspace-files', 'backup-trash']) changed = changed.replace(`'./${name}'`, JSON.stringify(pathToFileURL(resolve(`server/src/${name}.ts`)).href));
    await writeFile(modulePath, changed);
    let test = await readFile(`server/test/${variant.test}.test.ts`, 'utf8');
    test = test.replace("'../src/backups'", JSON.stringify(pathToFileURL(modulePath).href));
    for (const spec of ['../src/app', '../src/workspace-files', '../src/backup-trash', './fake-engine', './acl', './locks']) test = test.replace(`'${spec}'`, JSON.stringify(pathToFileURL(resolve('server/test', spec + '.ts')).href));
    await writeFile(testPath, test);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', variant.pattern, testPath], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 });
    const output = child.stdout + child.stderr, killed = child.status === 1 && output.includes('AssertionError');
    records.push({ name: variant.name, pattern: variant.pattern, exitCode: child.status, mutationKilled: killed, output });
    assert.ok(killed, `${variant.name}: survived or failed for a non-assertion reason\n${output}`);
  }
  await writeFile('docs/verification/issue4/mutations-round4.json', JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'), records }, null, 2));
  console.log('PASS: 5/5 mutants killed by actual safety assertions');
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
