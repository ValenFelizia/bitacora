import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

test('repository sources are UTF-8 without BOM or broken Spanish characters', async () => {
  const extensions=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.html','.css','.md','.svg']);
  const errors:string[]=[];
  async function scan(dir:string) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      if (['node_modules','dist'].includes(entry.name)) continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory()) await scan(path);
      else if(entry.isFile() && extensions.has(extname(path))) {
        const bytes=await readFile(path);
        if (['efbbbf','fffe','feff','0000feff'].some(bom=>bytes.subarray(0,bom.length/2).toString('hex')===bom)) errors.push(`${path}: BOM`);
        try {
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
          if (/\u00c3[\p{Cc}\u00a9\u00b3\u00b1\u00a1\u00ad]/u.test(text)) errors.push(`${path}: broken accents`);
        } catch { errors.push(`${path}: invalid UTF-8`); }
      }
    }
  }
  for(const root of ['server','web/src','scripts','kit']) await scan(root);
  assert.deepEqual(errors,[]);
});
