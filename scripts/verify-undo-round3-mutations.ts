// Each mutant runs the actual regression test in a disposable module tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/undo-r3-mutants-'));
const source = await readFile('server/src/backups.ts', 'utf8');
const originalTest = await readFile('server/test/undo-round3.test.ts', 'utf8');
const variants = [
  { name: 'remove descendant-later-change guard', pattern: 'N6 later edits in a directory-to-file',
    mutate: (s: string) => s.split('\n').filter(line => !line.includes("'hay cambios posteriores dentro de esa carpeta'")).join('\n') },
  { name: 'remove immediate pre-open/write route recheck', pattern: 'N5/N6 recheck immediately before write',
    mutate: (s: string) => s.replace('const initialFolder = await this.checkAbsolute(temporary);', 'const initialFolder = await realpath(dirname(temporary));') },
  { name: 'remove immediate pre-rename route rechecks', pattern: 'N5/N6 recheck immediately before rename',
    mutate: (s: string) => s.replace('const sourceParent = await this.checkAbsolute(from), targetParent = await this.checkAbsolute(to);', 'const sourceParent = dirname(from), targetParent = dirname(to);') },
];
const records: unknown[] = [];
try {
  for (const [i, variant] of variants.entries()) {
    const modulePath = join(base, `mutant-${i}.ts`), testPath = join(base, `case-${i}.test.ts`);
    const changed = variant.mutate(source); assert.notEqual(changed, source);
    await writeFile(modulePath, changed.replace("'./workspace-files'", JSON.stringify(pathToFileURL(resolve('server/src/workspace-files.ts')).href)).replace("'./backup-trash'", JSON.stringify(pathToFileURL(resolve('server/src/backup-trash.ts')).href)));
    let test = originalTest.replace("'../src/backups'", JSON.stringify(pathToFileURL(modulePath).href));
    for (const spec of ['../src/app', '../src/workspace-files', '../test/fake-engine']) {
      const actualSpec = spec === '../test/fake-engine' ? './fake-engine' : spec;
      const file = spec.startsWith('../src') ? resolve('server/test', spec + '.ts') : resolve('server/test/fake-engine.ts');
      test = test.replace(JSON.stringify(actualSpec), JSON.stringify(pathToFileURL(file).href)).replace(`'${actualSpec}'`, JSON.stringify(pathToFileURL(file).href));
    }
    for (const spec of ['./acl', './locks']) test = test.replace(`'${spec}'`, JSON.stringify(pathToFileURL(resolve('server/test', spec + '.ts')).href));
    await writeFile(testPath, test);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', variant.pattern, testPath], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 ** 2 });
    const output = child.stdout + child.stderr;
    const killed = child.status === 1 && output.includes('AssertionError');
    records.push({ name: variant.name, pattern: variant.pattern, exitCode: child.status, mutationKilled: killed, output });
    assert.ok(killed, `Mutant survived or failed for a non-assertion reason: ${variant.name}\n${output}`);
  }
  await writeFile('docs/verification/issue4/mutations-round3.json', JSON.stringify({ sourceSha256: createHash('sha256').update(source).digest('hex'), records }, null, 2));
  console.log('PASS: 3/3 mutants killed by actual safety assertions');
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
