import { AgencyFiles } from './paths';
import { withPage, visibleTexts } from './page';

export const numbers = (s: string) => s.match(/\d+(?:[.,]\d+)*/g) || [];
export const normalizeNumber = (s: string) => s.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
export type Rules = { operatorNames?: string[]; noEmoji?: boolean; warnExperience?: boolean };
export async function controlar(files: AgencyFiles, input: { html: string; source: string; report: string; rules?: string }) {
  const source = (await files.read(input.source)).split(/\r?\n/);
  const rules: Rules = input.rules ? JSON.parse((await files.read(input.rules)).replace(/^\uFEFF/, '')) : {};
  const texts = await withPage(files, input.html, visibleTexts);
  const errors: string[] = [], warnings: string[] = [];
  const rows: string[] = [];
  for (const {text, where, cites} of texts) {
    if (rules.operatorNames?.some(name => name && text.toLocaleLowerCase().includes(name.toLocaleLowerCase()))) errors.push(`${where}: nombra al operador.`);
    if (rules.noEmoji && /\p{Extended_Pictographic}/u.test(text)) errors.push(`${where}: tiene emojis.`);
    if (rules.warnExperience && /\b(estuve|visit[eé]|conoc[ií]|me hosped[eé])\b/i.test(text)) warnings.push(`${where}: confirmá con la usuaria si estuvo en ese lugar.`);
    for (const number of numbers(text)) {
      const line = cites?.[number];
      const quoted = Number.isInteger(line) && line > 0 ? source[line - 1] : undefined;
      const ok = !!quoted && numbers(quoted).some(n => normalizeNumber(n) === normalizeNumber(number));
      if (!ok) errors.push(`${where}: ${number} no está respaldado por la línea citada (${line ?? 'sin cita'}).`);
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      rows.push(`| ${number} | ${esc(where)} | ${line ?? 'sin cita'} | ${esc(quoted ?? 'No encontrada')} | ${ok ? 'Sí' : 'No'} |`);
    }
  }
  await files.write(input.report, ['# Control de los números', '', `Fuente: ${input.source}`, '', '| Número | Dónde se ve | Línea | Texto de la fuente | Respaldado |', '| --- | --- | --- | --- | --- |', ...rows, '', '## Errores', ...errors.map(s => `- ${s}`), '', '## Avisos', ...warnings.map(s => `- ${s}`)].join('\n'), false);
  return { ok: errors.length === 0, checked: rows.length, errors, warnings, report: input.report };
}
