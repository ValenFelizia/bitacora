// Descarga reproducible desde Google Fonts; no se ejecuta en la agencia.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const families = ['Lora','Fraunces','Manrope','Source Sans 3','Outfit','Caveat'];
const records = [];
const cssRules = [];
async function get(url, headers) {
  const r = await fetch(url, {headers});
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return r;
}
const commit = (await (await get('https://api.github.com/repos/google/fonts/commits/main')).json()).sha;
for (const name of families) {
  const slug = name.toLowerCase().replaceAll(' ', '');
  const dir = `kit/turismo/fuentes/${slug}`;
  await mkdir(dir, {recursive:true});
  const licenseUrl = `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/${slug}/OFL.txt`;
  const license = await (await get(licenseUrl)).text();
  if (!license.includes('SIL OPEN FONT LICENSE Version 1.1')) throw new Error(`Licencia inesperada: ${name}`);
  await writeFile(`${dir}/OFL.txt`,license);
  const cssUrl = `https://fonts.googleapis.com/css2?family=${name.replaceAll(' ','+')}:wght@400;600&display=swap`;
  const css = await (await get(cssUrl, {'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'})).text();
  // El subconjunto latino incluye castellano completo y evita descargar otros alfabetos.
  const latin = [...css.matchAll(/\/\* latin \*\/\s*(@font-face\s*\{[^}]+\})/g)].map(m=>m[1]);
  if (!latin.length) throw new Error(`Falta latín: ${name}`);
  const urls = new Map();
  for (const rule of latin) {
    const url = rule.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!url) throw new Error(`Falta WOFF2: ${name}`);
    let file = urls.get(url);
    if (!file) {
      file = `${slug}-${urls.size+1}.woff2`; urls.set(url,file);
      const bytes = Buffer.from(await (await get(url)).arrayBuffer());
      if (bytes.toString('ascii',0,4) !== 'wOF2') throw new Error('Formato incorrecto');
      await writeFile(`${dir}/${file}`,bytes);
      records.push({familia:name,archivo:`${slug}/${file}`,origen:url,licencia:licenseUrl,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    cssRules.push(rule.replace(url,`${slug}/${file}`));
  }
}
const total = records.reduce((s,r)=>s+r.bytes,0);
if(total>=3000000) throw new Error(`Demasiados bytes: ${total}`);
await writeFile('kit/turismo/fuentes/fuentes.css',cssRules.join('\n'));
await writeFile('kit/turismo/fuentes/procedencia.json',JSON.stringify({repositorio:`https://github.com/google/fonts/tree/${commit}`,totalBytes:total,archivos:records},null,2)+'\n');
console.log({total,families});
