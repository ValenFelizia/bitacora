import { AgencyFiles } from './paths';
import { withPage, visibleTexts } from './page';

export const numbers = (s: string) => s.match(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu) || [];
export const normalizeNumber = (s: string) => {
  s = s.replace(/\p{Nd}/gu, digit => {
    const cp = digit.codePointAt(0)!;
    let zero = cp;
    while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  });
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return s.replace(/[.,]/g, '');
  return s.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
};
export type Rules = { operatorNames?: string[]; noEmoji?: boolean; warnExperience?: boolean };
export async function controlar(files: AgencyFiles, input: { html: string; source: string; report: string; rules?: string }) {
  const source = (await files.read(input.source)).split(/\r?\n/);
  const rules: Rules = input.rules ? JSON.parse((await files.read(input.rules)).replace(/^\uFEFF/, '')) : {};
  const {texts,whole} = await withPage(files, input.html, async page => ({texts:await visibleTexts(page),whole:await page.evaluate(() => document.body.innerText)}));
  const errors: string[] = [], warnings: string[] = [];
  const rows: string[] = [];
  const cited = new Map<string,string>(), used = new Set<string>();
  const operatorText = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{Cf}]/gu,'');
  const visible = operatorText(whole + '\n' + texts.map(t=>t.text).join('\n'));
  if (rules.operatorNames?.some(name => name && visible.includes(operatorText(name)))) errors.push('La pieza nombra al operador.');
  for (const {text, where, cites, citationId} of texts) {
    for (const number of Object.keys(cites || {})) cited.set(`${citationId}:${number}`, `${where}: sobra la cita de ${number} (línea ${cites[number]}).`);
    if (rules.noEmoji && /\p{Extended_Pictographic}/u.test(text)) errors.push(`${where}: tiene emojis.`);
    if (rules.warnExperience && /(?<!\p{L})(estuve|visit[eé]|conoc[ií]|me hosped[eé])(?!\p{L})/iu.test(text)) warnings.push(`${where}: confirmá con la usuaria si estuvo en ese lugar.`);
    for (const number of numbers(text)) {
      const line = cites?.[number];
      used.add(`${citationId}:${number}`);
      const quoted = Number.isInteger(line) && line > 0 ? source[line - 1] : undefined;
      const ok = !!quoted && numbers(quoted).some(n => normalizeNumber(n) === normalizeNumber(number));
      if (!ok) errors.push(`${where}: ${number} no está respaldado por la línea citada (${line ?? 'sin cita'}).`);
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
      rows.push(`| ${number} | ${esc(where)} | ${line ?? 'sin cita'} | ${esc(quoted ?? 'No encontrada')} | ${ok ? 'Sí' : 'No'} |`);
    }
  }
  for (const [key,message] of cited) if (!used.has(key)) warnings.push(message);
  await files.write(input.report, ['# Control de los números', '', `Fuente: ${input.source}`, '', '| Número | Dónde se ve | Línea | Texto de la fuente | Respaldado |', '| --- | --- | --- | --- | --- |', ...rows, '', '## Errores', ...errors.map(s => `- ${s}`), '', '## Avisos', ...warnings.map(s => `- ${s}`)].join('\n'), false);
  return { ok: errors.length === 0, checked: rows.length, errors, warnings, report: input.report };
}
