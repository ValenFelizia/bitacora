import { chromium, type Page } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative } from 'node:path';
import { extname } from 'node:path';
import { load } from 'cheerio';
import { AgencyFiles } from './paths';

function validateMarkup(html: string) {
  const markup = load(html);
  const unsupported = markup('template[shadowrootmode],iframe,object,embed,input,textarea,select,button,form,output,meter,progress');
  if (unsupported.length) throw new Error(`Sacá de la pieza estas construcciones: ${[...new Set(unsupported.toArray().map(el => el.tagName))].join(', ')}. Usá texto y fotos en el HTML principal, sin paneles internos ni formularios.`);
}

export async function withPage<T>(files: AgencyFiles, html: string, run: (page: Page) => Promise<T>) {
  const path = await files.path(html);
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
        if (/counters?\s*\(/i.test(getComputedStyle(el,pseudo).content)) return 'content con counter o counters';
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
    const result: { text: string; where: string; cites: Record<string, number>; citationId?: number }[] = [];
    const owners = Array.from(document.querySelectorAll('[data-cites]'));
    for (const [citationId,el] of owners.entries()) {
      try { result.push({text:'',where:`Cita ${citationId + 1}`,cites:JSON.parse(el.getAttribute('data-cites')!),citationId}); }
      catch { throw new Error('Hay una cita mal escrita en la pieza. Revisá data-cites.'); }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement!;
      if (el.closest('script,style,noscript') || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !node.textContent?.trim()) continue;
      let cites = {};
      try { cites = JSON.parse(el.closest('[data-cites]')?.getAttribute('data-cites') || '{}'); } catch { /* Missing citations fail below. */ }
      result.push({ text: node.textContent, where: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: ${node.textContent.trim().slice(0, 100)}`, cites, citationId:owners.indexOf(el.closest('[data-cites]')!) });
    }
    // Generated content is visible too; never silently skip numbers in CSS counters.
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.checkVisibility()) continue;
      if (getComputedStyle(el).display === 'list-item' && /decimal|roman|alpha|latin/i.test(getComputedStyle(el).listStyleType)) result.push({text:'0', where:'Numeración automática de lista: reemplazala por texto con cita', cites:{}});
      for (const pseudo of ['::before', '::after', '::marker']) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && !['none', 'normal', '""'].includes(content)) result.push({ text: content, where: el.tagName + pseudo, cites: {} });
      }
    }
    return result;
  });
}
