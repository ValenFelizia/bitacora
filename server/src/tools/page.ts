import { chromium, type Page } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative } from 'node:path';
import { AgencyFiles } from './paths';

export async function withPage<T>(files: AgencyFiles, html: string, run: (page: Page) => Promise<T>) {
  const path = await files.path(html);
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
        await route.continue();
      } catch { blocked.push(route.request().url()); await route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(pathToFileURL(path).href, { waitUntil: 'load', timeout: 20000 });
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
    const result: { text: string; where: string; cites: Record<string, number> }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement!;
      if (el.closest('script,style,noscript') || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !node.textContent?.trim()) continue;
      let cites = {};
      try { cites = JSON.parse(el.closest('[data-cites]')?.getAttribute('data-cites') || '{}'); } catch { /* Missing citations fail below. */ }
      result.push({ text: node.textContent, where: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: ${node.textContent.trim().slice(0, 100)}`, cites });
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
