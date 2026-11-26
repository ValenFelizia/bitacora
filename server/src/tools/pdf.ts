import { fileURLToPath } from "node:url";
import { extname, join, dirname } from "node:path";
import { MAX_FILE } from "../workspace-files";
import { AgencyFiles } from "./paths";

const moduleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const packageRoot = join(dirname(fileURLToPath(moduleUrl)), "..", "..");
const asset = (name: string) => join(packageRoot, name) + "/";
export const PDF_PAGE_BATCH = 3;
/** Stop walking a page after this many text items, even when they add no text. */
export const PDF_TEXT_ITEMS = 2000;
export const pdfDocumentOptions = {
  useWorkerFetch: false,
  useSystemFonts: false,
  enableXfa: false,
  maxImageSize: 16_000_000,
  canvasMaxAreaInBytes: 64 * 1024 * 1024,
  stopAtErrors: true,
} as const;

export async function inspectPdf(files: AgencyFiles, path: string, start: number, count: number) {
  if (extname(path).toLowerCase() !== ".pdf") throw new Error("Elegí un archivo PDF.");
  const bytes = await files.readBuffer(path, MAX_FILE);
  if (bytes.toString("ascii", 0, 5) !== "%PDF-") throw new Error("No pude leer ese PDF.");
  const { createCanvas } = await import("@napi-rs/canvas");
  const pdf: typeof import("pdfjs-dist") = await import(moduleUrl);
  const task = pdf.getDocument({
    data: new Uint8Array(bytes),
    verbosity: pdf.VerbosityLevel.ERRORS,
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    ...pdfDocumentOptions,
  });
  try {
    const doc = await task.promise;
    if (start > doc.numPages) throw new Error("Esa página no existe en el PDF.");
    const pagesToRead = Math.min(PDF_PAGE_BATCH, Math.max(1, Math.floor(count)));
    const end = Math.min(start + pagesToRead - 1, doc.numPages);
    const pages = [];
    for (let number = start; number <= end && pages.length < PDF_PAGE_BATCH; number++) {
      const page = await doc.getPage(number);
      const size = page.getViewport({ scale: 96 / 72 });
      const scale = Math.min(2, 1600 / Math.max(size.width, size.height)) * 96 / 72;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      await page.render({
        canvas: null,
        // PDF.js's types describe DOM canvas only; its Node backend uses
        // this same native canvas implementation.
        canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      let text = "";
      const items = (await page.getTextContent()).items;
      const itemLimit = Math.min(items.length, PDF_TEXT_ITEMS);
      for (let index = 0; index < itemLimit; index++) {
        const item = items[index];
        if (item && "str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
        if (text.length >= 6000) break;
      }
      pages.push({
        page: number,
        width: Math.round(size.width),
        height: Math.round(size.height),
        text: text.slice(0, 6000),
        image: canvas.toBuffer("image/png"),
      });
      page.cleanup();
    }
    return { totalPages: doc.numPages, nextPage: end < doc.numPages ? end + 1 : null, pages };
  } finally {
    await task.destroy();
  }
}
