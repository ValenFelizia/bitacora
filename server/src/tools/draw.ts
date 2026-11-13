import { AgencyFiles } from './paths';
import { withPage } from './page';

export async function dibujar(files: AgencyFiles, input: { html: string; destination: string; width: number; height: number }) {
  return withPage(files, input.html, async page => {
    const diagnostics = await page.evaluate(({width, height}) => {
      const errors: string[] = [], warnings: string[] = [];
      const pieces = [...document.querySelectorAll<HTMLElement>('[data-piece]')];
      if (!pieces.length || pieces.length > 12) errors.push('La página debe tener entre 1 y 12 piezas con data-piece.');
      for (const [i, piece] of pieces.entries()) {
        const bounds = piece.getBoundingClientRect();
        if (Math.abs(bounds.width - width) > 0.1 || Math.abs(bounds.height - height) > 0.1) errors.push(`Pieza ${i + 1}: el tamaño no es ${width} × ${height}.`);
        for (const el of [piece, ...piece.querySelectorAll<HTMLElement>('*')]) {
          if (!el.checkVisibility()) continue;
          const box = el.getBoundingClientRect();
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 || box.left < bounds.left - 1 || box.top < bounds.top - 1 || box.right > bounds.right + 1 || box.bottom > bounds.bottom + 1) errors.push(`Pieza ${i + 1}: no entra ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.`);
        }
      }
      for (const img of document.images) {
        if (!img.complete || !img.naturalWidth) errors.push(`No se pudo abrir la foto ${img.getAttribute('src')}.`);
        else if (img.naturalWidth < 800 || img.naturalHeight < 800) warnings.push(`La foto ${img.getAttribute('src')} es chica (${img.naturalWidth} × ${img.naturalHeight}).`);
      }
      return { errors: [...new Set(errors)], warnings };
    }, input);
    const backgrounds = await page.evaluate(async () => {
      const urls = new Set<string>();
      for (const el of document.body.querySelectorAll('*')) {
        for (const match of getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]);
      }
      const warnings: string[] = [], errors: string[] = [];
      for (const url of urls) {
        const img = new Image(); img.src = url;
        try {
          await img.decode();
          if (img.naturalWidth < 800 || img.naturalHeight < 800) warnings.push(`Una foto de fondo es chica (${img.naturalWidth} × ${img.naturalHeight}).`);
        } catch { errors.push('No se pudo abrir una foto de fondo.'); }
      }
      return {warnings,errors};
    });
    diagnostics.errors.push(...backgrounds.errors); diagnostics.warnings.push(...backgrounds.warnings);
    if (diagnostics.errors.length) return { ok: false, ...diagnostics, files: [] };
    const outputs: string[] = [];
    for (const [i, piece] of (await page.locator('[data-piece]').all()).entries()) {
      const path = `${input.destination}/pieza-${i + 1}.png`;
      await files.write(path, await piece.screenshot()); outputs.push(path);
    }
    await page.evaluate(content => { const style = document.createElement("style"); style.textContent = content; document.head.append(style); }, `@page {size:${input.width}px ${input.height}px;margin:0} @media print {body{margin:0!important;display:block!important} [data-piece]{break-after:page;margin:0!important} }`);
    const pdf = `${input.destination}/piezas.pdf`;
    await files.write(pdf, await page.pdf({ printBackground: true, preferCSSPageSize: true })); outputs.push(pdf);
    const overview = `${input.destination}/todas.png`;
    await page.evaluate(content => { const style = document.createElement("style"); style.textContent = content; document.head.append(style); }, '[data-piece]{zoom:0.25;margin:8px!important} body{display:flex;flex-wrap:wrap;margin:0}');
    await page.setViewportSize({width: Math.min(outputs.length - 1, 3) * (Math.ceil(input.width / 4) + 16), height: Math.ceil(input.height / 4) + 16});
    await files.write(overview, await page.screenshot({ fullPage: true })); outputs.push(overview);
    return { ok: true, ...diagnostics, files: outputs };
  });
}
