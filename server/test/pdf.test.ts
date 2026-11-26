import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { inspectPdf, PDF_PAGE_BATCH, PDF_TEXT_ITEMS, pdfDocumentOptions } from "../src/tools/pdf";
import { AgencyFiles } from "../src/tools/paths";

function buildPdf(streams: string[]) {
  const objects = [""];
  const add = (body: string) => { objects.push(body); return objects.length - 1; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const contents = streams.map(stream =>
    add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`));
  const pages = add("");
  const pageIds = streams.map((_, index) => add(
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 240 240] /Contents ${contents[index]} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  objects[pages] = `<< /Type /Pages /Kids [${pageIds.map(id => id + " 0 R").join(" ")}] /Count ${pageIds.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let number = 1; number < objects.length; number++) {
    offsets[number] = Buffer.byteLength(body, "latin1");
    body += `${number} 0 obj\n${objects[number]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number++)
    body += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function crowdedPage(items: number, tail: string) {
  let stream = "BT /F1 12 Tf 20 220 Td\n";
  for (let index = 0; index < items; index++) stream += "(A) Tj 0 -0.05 Td\n";
  stream += `(${tail}) Tj\nET`;
  return stream;
}

test("pdf reading stays off system fonts and stops after a bounded number of pages and items", async () => {
  assert.equal(pdfDocumentOptions.useSystemFonts, false);
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(resolve(".local", "pdf-"));
  const files = new AgencyFiles(root);
  try {
    const pages = [
      crowdedPage(PDF_TEXT_ITEMS, "SENTINEL"),
      ...Array.from({ length: 4 }, (_, index) => `BT /F1 12 Tf 20 200 Td (Pagina ${index + 2}) Tj ET`),
    ];
    await files.write("hostil.pdf", buildPdf(pages));
    const result = await inspectPdf(files, "hostil.pdf", 1, 99);
    assert.equal(result.totalPages, 5);
    assert.equal(result.pages.length, PDF_PAGE_BATCH);
    assert.equal(result.nextPage, PDF_PAGE_BATCH + 1);
    assert.equal(result.pages.map(page => page.page).join(","), "1,2,3");
    assert.match(result.pages[0].text, /A/);
    assert.doesNotMatch(result.pages[0].text, /SENTINEL/);
    assert.ok(result.pages[0].image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.match(result.pages[2].text, /Pagina 3/);
    assert.equal(result.pages.some(page => /Pagina [45]/.test(page.text)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
