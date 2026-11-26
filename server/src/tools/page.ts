import { chromium, type Page } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, sep } from 'node:path';
import { extname } from 'node:path';
import { load } from 'cheerio';
import { AgencyFiles } from './paths';

function validateMarkup(html: string) {
  const markup = load(html);
  const unsupported = markup('template[shadowrootmode],iframe,object,embed,input,textarea,select,button,form,output,meter,progress,svg text,svg tspan,svg foreignObject');
  if (unsupported.length) throw new Error(`Sacá de la pieza estas construcciones: ${[...new Set(unsupported.toArray().map(el => el.tagName))].join(', ')}. Usá texto y fotos en el HTML principal, sin paneles internos ni formularios.`);
}

export async function withPage<T>(files: AgencyFiles, html: string, run: (page: Page) => Promise<T>, resourceRoot?: string) {
  const path = await files.path(html);
  const assets = resourceRoot && await files.path(resourceRoot);
  validateMarkup(await files.read(html));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const timer = setTimeout(() => { void browser.close(); }, 60000);
  try {
    const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block' });
    const blocked: string[] = [];
    await context.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.protocol !== 'file:') throw new Error('Recurso externo');
        const local = fileURLToPath(url);
        if (assets && !local.toLowerCase().startsWith(assets.toLowerCase() + sep)) throw new Error('Recurso fuera de la plantilla');
        const safe = await files.path(relative(await files.path('.'), local));
        if (safe.toLowerCase() !== local.toLowerCase()) throw new Error('Ruta no válida');
        const body = await files.readBuffer(relative(await files.path('.'), safe));
        if (safe === path) validateMarkup(body.toString('utf8'));
        const types: Record<string,string> = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2'};
        await route.fulfill({status:200,body,contentType:types[extname(safe).toLowerCase()] || 'application/octet-stream'});
      } catch { blocked.push(route.request().url()); await route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(pathToFileURL(path).href, { waitUntil: 'load', timeout: 20000 });
    const forbidden = await page.evaluate(() => {
      if (getComputedStyle(document.head).display !== 'none' || Array.from(document.querySelectorAll('title')).some(el=>getComputedStyle(el).display !== 'none')) return 'head/title visibles';
      if (Array.from(document.querySelectorAll('*')).some(el => el.shadowRoot)) return 'shadow DOM';
      if (document.querySelector('iframe,object,embed,input,textarea,select,button,form,output,meter,progress')) return 'paneles internos o formularios';
      for (const el of document.querySelectorAll('*')) {
        if (getComputedStyle(el).display === 'list-item' && !['none','disc','circle','square'].includes(getComputedStyle(el).listStyleType)) return 'listas con numeración o texto generado (list-style-type)';
        for (const pseudo of ['::before','::after','::marker']) {
          const content=getComputedStyle(el,pseudo).content;
          if(getComputedStyle(el).display==='contents' && content && !['none','normal','""'].includes(content)) return 'pseudo-elementos en display:contents';
          if (/counters?\s*\(/i.test(content)) return 'content con counter o counters';
        }
      }
      const pending = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules));
      for (let i = 0; i < pending.length; i++) {
        const rule = pending[i];
        if (/^@(?:page|counter-style)\b/i.test(rule.cssText)) return 'reglas @page o @counter-style';
        if ('style' in rule) {
          const style = (rule as CSSStyleRule).style;
          if (style.listStyleType && !['none','disc','circle','square'].includes(style.listStyleType)) return 'list-style-type con numeración o texto generado';
          if (style.display && style.display !== 'none' && document.head.matches((rule as CSSStyleRule).selectorText)) return 'reglas que muestran head/title';
          if (style.display && style.display !== 'none' && Array.from(document.querySelectorAll('title')).some(el=>el.matches((rule as CSSStyleRule).selectorText))) return 'reglas que muestran head/title';
        }
        if ('style' in rule && /counters?\s*\(/i.test((rule as CSSStyleRule).style.content)) return 'content con counter o counters';
        if ('cssRules' in rule) pending.push(...Array.from((rule as CSSGroupingRule).cssRules));
      }
      return '';
    });
    if (forbidden) throw new Error(`Sacá ${forbidden} de la pieza. Escribí el contenido como texto con citas en el HTML principal.`);
    // evaluate is available even when scripts in the input document are disabled.
    await page.evaluate(async () => { await document.fonts.ready; });
    const broken = await page.evaluate(() => Array.from(document.fonts).filter(f => f.status === 'error').map(f => f.family));
    if (broken.length) throw new Error(`No se pudieron cargar las fuentes: ${broken.join(', ')}.`);
    if (blocked.length) throw new Error(`Se bloquearon recursos fuera de la agencia: ${blocked.join(', ')}`);
    return await run(page);
  } finally { clearTimeout(timer); await browser.close(); }
}

export async function visibleTexts(page: Page) {
  return page.evaluate(() => {
    const result: { text: string; where: string; cites: Record<string, number | string>; citationId?: number; skipNumbers?: boolean }[] = [];
    const owners = Array.from(document.querySelectorAll('[data-cites]'));
    for (const [citationId,el] of owners.entries()) {
      try { result.push({text:'',where:`Cita ${citationId + 1}`,cites:JSON.parse(el.getAttribute('data-cites')!),citationId}); }
      catch { throw new Error('Hay una cita mal escrita en la pieza. Revisá data-cites.'); }
    }
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    const groups: {text:string;parts:{node:Node;start:number;end:number}[]}[]=[];
    let previous: {node:Node;block:Element;box:DOMRect}|undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement!;
      const raw=node.textContent || '';
      // Only computed styles can establish that text is certainly hidden.
      if (!raw || ['hidden','collapse'].includes(getComputedStyle(el).visibility)) continue;
      let hidden=false;
      for(let ancestor:Element|null=el;ancestor;ancestor=ancestor.parentElement) if(getComputedStyle(ancestor).display==='none'){hidden=true;break;}
      if(hidden)continue;
      let block:Element=el;
      while(block.parentElement && ['inline','inline-block','inline-flex','inline-grid','contents'].includes(getComputedStyle(block).display) && !['TD','TH'].includes(block.tagName)) block=block.parentElement;
      const first=document.createRange(),last=document.createRange();
      first.setStart(node,0);first.setEnd(node,1);last.setStart(node,raw.length-1);last.setEnd(node,raw.length);
      const box=first.getBoundingClientRect();
      let separated=!previous || previous.block!==block;
      if(previous && !separated) {
        const between=document.createRange();between.setStartAfter(previous.node);between.setEndBefore(node);
        separated=!!between.cloneContents().querySelector('br');
        // Geometry can separate known text runs, never exclude text from control.
        if(box.width>0 && box.height>0 && previous.box.width>0 && previous.box.height>0) {
          if(box.left-previous.box.right>1)separated=true;
          if(!el.closest('sup,sub') && !previous.node.parentElement?.closest('sup,sub') && box.top>=previous.box.bottom-1) separated=true;
        }
      }
      if(separated) groups.push({text:'',parts:[]});
      const group=groups.at(-1)!;
      const text=(getComputedStyle(el).whiteSpace.startsWith('pre') ? raw : raw.replace(/\s+/g,' ')).replace(/\p{Cf}/gu,'');
      group.parts.push({node,start:group.text.length,end:group.text.length+text.length});group.text+=text;
      previous={node,block,box:last.getBoundingClientRect()};
    }
    for(const group of groups) {
      const where=group.text.trim().slice(0,120);
      result.push({text:group.text,where,cites:{},skipNumbers:true});
      for(const match of group.text.matchAll(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu)) {
        const parts=group.parts.filter(p=>p.end>match.index! && p.start<match.index!+match[0].length);
        let common=parts[0].node.parentElement!;
        while(common.parentElement && parts.some(p=>!common.contains(p.node))) common=common.parentElement;
        const owner=common.closest('[data-cites]');
        const cites=owner ? JSON.parse(owner.getAttribute('data-cites')!) : {};
        result.push({text:match[0],where:`${common.tagName.toLowerCase()}: ${where}`,cites,citationId:owners.indexOf(owner!)});
      }
    }
    // Generated content is visible too; never silently skip numbers in CSS counters.
    for (const el of document.querySelectorAll('*')) {
      let hidden=false;
      for(let ancestor:Element|null=el;ancestor;ancestor=ancestor.parentElement)if(getComputedStyle(ancestor).display==='none'){hidden=true;break;}
      if(hidden)continue;
      for (const pseudo of ['::before', '::after', '::marker']) {
        const style=getComputedStyle(el,pseudo);
        if(style.display==='none' || ['hidden','collapse'].includes(style.visibility))continue;
        const content = style.content;
        if (content && !['none', 'normal', '""'].includes(content)) result.push({ text: content, where: el.tagName + pseudo, cites: {} });
      }
    }
    return result;
  });
}
