import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Deliberate, sequential mutation checks. Each original file is restored in finally.
const require = createRequire(import.meta.url);
const results: unknown[] = [];
for (const mutation of [
  {point:5,path:'server/src/tools/paths.ts',pattern:'write race',change:(s:string)=>"import { lstatSync } from 'node:fs';\n" + s.replace(/lockDirectory\((root|current)\)/g,'(lstatSync($1), () => {})')},
  {point:10,path:'server/package.json',pattern:'production server declares',change:(s:string)=>{
    const pkg=JSON.parse(s); delete pkg.dependencies.tsx; delete pkg.dependencies['playwright-core']; return JSON.stringify(pkg,null,2);
  }},
]) {
  const original=await readFile(mutation.path,'utf8');
  try {
    const changed=mutation.change(original); assert.notEqual(changed,original);
    await writeFile(mutation.path,changed,'utf8');
    const run=spawnSync(process.execPath,['--import',pathToFileURL(require.resolve('tsx/esm')).href,'--test',`--test-name-pattern=${mutation.pattern}`,'server/test/kit-final.test.ts'],{encoding:'utf8',windowsHide:true,timeout:30000});
    results.push({point:mutation.point,status:run.status,stdout:run.stdout,stderr:run.stderr,error:run.error?.message});
    assert.equal(run.status,1,JSON.stringify(results.at(-1)));
    assert.match(run.stdout+run.stderr,/AssertionError/);
  } finally {await writeFile(mutation.path,original,'utf8');}
}
await writeFile('docs/verification/issue6/final-mutations.json',JSON.stringify(results,null,2),'utf8');
console.log('PASS: mutations of fixes 5 and 10 are detected by regression tests.');
