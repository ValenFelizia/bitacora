import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileRef, Work } from "../src/contracts";
import {
  formatTime,
  formatWorkDate,
  groupDeliverableBatches,
  messageDeliverableCount,
  undoSummary,
} from "../../web/src/format";

const makeFile = (
  name: string,
  mime = "image/png",
  createdAt = "2026-11-16T14:05:00.000Z",
  path = name,
  id = path,
): FileRef => ({
  id,
  name,
  mime,
  path,
  createdAt,
});

const makeWork = (overrides: Partial<Work> = {}): Work => ({
  id: "w1",
  title: "Porto de Galinhas, febrero",
  details: "",
  createdAt: "2026-11-16T14:00:00.000Z",
  updatedAt: "2026-11-16T14:05:00.000Z",
  busy: false,
  progress: "Listo.",
  messages: [],
  ...overrides,
});

test("formatWorkDate returns hoy for same local calendar day and short date otherwise", () => {
  const now = new Date(2026, 10, 16, 15, 0, 0);
  const sameDay = new Date(2026, 10, 16, 9, 30, 0).toISOString();
  const earlierDay = new Date(2026, 10, 14, 18, 0, 0).toISOString();
  assert.equal(formatWorkDate(sameDay, now), "hoy");
  const formatted = formatWorkDate(earlierDay, now);
  assert.match(formatted, /^14\b/);
  assert.doesNotMatch(formatted, /\.$/);
  assert.equal(formatWorkDate("not-a-date", now), "");
});

test("formatTime returns HH:MM in 24-hour format and empty string on invalid input", () => {
  const d = new Date(2026, 10, 16, 14, 5, 0).toISOString();
  assert.equal(formatTime(d), "14:05");
  assert.equal(formatTime("invalid"), "");
});

test("groupDeliverableBatches promotes multi-plate batch to hero and keeps older batches grouped", () => {
  const work = makeWork({
    messages: [
      { id: "m1", role: "user", text: "Cotización" },
      {
        id: "m2",
        role: "assistant",
        text: "Acá tenés el PDF.",
        results: [makeFile("Cotización.pdf", "application/pdf", "2026-11-16T13:10:00.000Z")],
      },
      { id: "m3", role: "user", text: "Ahora las placas" },
      {
        id: "m4",
        role: "assistant",
        text: "Listo.",
        results: [
          makeFile("todas.png", "image/png", "2026-11-16T14:04:00.000Z"),
          makeFile("pieza-3.png", "image/png", "2026-11-16T14:05:00.000Z"),
          makeFile("pieza-1.png", "image/png", "2026-11-16T14:05:00.000Z"),
          makeFile("pieza-2.png", "image/png", "2026-11-16T14:05:00.000Z"),
          makeFile("pieza-4.png", "image/png", "2026-11-16T14:05:00.000Z"),
          makeFile("piezas.pdf", "application/pdf", "2026-11-16T14:05:00.000Z"),
        ],
      },
    ],
  });

  const grouped = groupDeliverableBatches(work);
  assert.ok(grouped.featured);
  assert.equal(grouped.featured.title, "Porto de Galinhas, febrero");
  assert.match(grouped.featured.meta, /^4 placas/);
  assert.deepEqual(
    grouped.featured.plates.map((p) => p.name),
    ["pieza-1.png", "pieza-2.png", "pieza-3.png", "pieza-4.png"],
  );
  assert.equal(grouped.featured.primary.name, "pieza-1.png");
  assert.ok(grouped.featured.allFiles.some((f) => f.name === "piezas.pdf"));
  assert.equal(grouped.olderGroups.length, 1);
  assert.equal(grouped.olderGroups[0].primary.name, "Cotización.pdf");
  assert.equal(messageDeliverableCount(work, "m4"), 4);

  const targeted = groupDeliverableBatches(work, "m2");
  assert.equal(targeted.featured?.id, "m2");
  assert.equal(targeted.featured?.primary.name, "Cotización.pdf");
  assert.equal(targeted.olderGroups.length, 1);
  assert.equal(targeted.olderGroups[0].id, "m4");
});

test("groupDeliverableBatches handles single-plate, single-PDF, empty works, and multi-folder splits", () => {
  assert.deepEqual(groupDeliverableBatches(undefined), { olderGroups: [] });
  assert.deepEqual(groupDeliverableBatches(makeWork()), { olderGroups: [] });

  const singlePlate = groupDeliverableBatches(
    makeWork({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Placa única",
          results: [
            makeFile("pieza-1.png", "image/png"),
            makeFile("piezas.pdf", "application/pdf"),
          ],
        },
      ],
    }),
  );
  assert.equal(singlePlate.featured?.title, "Porto de Galinhas, febrero");
  assert.match(singlePlate.featured?.meta ?? "", /^1 placa/);
  assert.equal(singlePlate.featured?.plates.length, 1);
  assert.equal(singlePlate.olderGroups.length, 0);

  const single = groupDeliverableBatches(
    makeWork({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "PDF",
          results: [makeFile("viaje.pdf", "application/pdf")],
        },
      ],
    }),
  );
  assert.equal(single.featured?.title, "viaje.pdf");
  assert.equal(single.featured?.plates.length, 0);
  assert.equal(single.olderGroups.length, 0);

  // One message touching two proposal folders splits into two separate groups.
  const multiFolder = groupDeliverableBatches(
    makeWork({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Dos propuestas.",
          results: [
            makeFile("pieza-1.png", "image/png", "2026-11-16T14:00:00.000Z", "propuestas/porto/salida/pieza-1.png"),
            makeFile("pieza-2.png", "image/png", "2026-11-16T14:00:00.000Z", "propuestas/porto/salida/pieza-2.png"),
            makeFile("pieza-1.png", "image/png", "2026-11-16T14:01:00.000Z", "propuestas/cancun/salida/pieza-1.png"),
            makeFile("pieza-2.png", "image/png", "2026-11-16T14:01:00.000Z", "propuestas/cancun/salida/pieza-2.png"),
          ],
        },
      ],
    }),
  );
  assert.equal(multiFolder.featured?.title, "Cancun");
  assert.equal(multiFolder.featured?.plates.length, 2);
  assert.equal(multiFolder.olderGroups.length, 1);
  assert.equal(multiFolder.olderGroups[0].title, "Porto");
  assert.equal(multiFolder.olderGroups[0].plates.length, 2);

  // Reference photos in another folder do not split or overshadow a single plates folder.
  const platesAndRefs = groupDeliverableBatches(
    makeWork({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Placas y referencia.",
          results: [
            makeFile("pieza-1.png", "image/png", "2026-11-16T14:00:00.000Z", "propuestas/porto/salida/pieza-1.png"),
            makeFile("pieza-2.png", "image/png", "2026-11-16T14:00:00.000Z", "propuestas/porto/salida/pieza-2.png"),
            makeFile("playa.jpg", "image/jpeg", "2026-11-16T14:01:00.000Z", "referencias/playa.jpg"),
          ],
        },
      ],
    }),
  );
  assert.equal(platesAndRefs.featured?.kind, "plates");
  assert.equal(platesAndRefs.featured?.plates.length, 2);
  assert.equal(platesAndRefs.olderGroups.length, 0);
  assert.equal(platesAndRefs.featured?.allFiles.some((f) => f.name === "playa.jpg"), true);

  // Two plate folders + a reference folder: plates group is always featured even if refs appear later.
  const twoPlatesAndRefs = groupDeliverableBatches(
    makeWork({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Dos propuestas y refs.",
          results: [
            makeFile("pieza-1.png", "image/png", "2026-11-16T14:00:00.000Z", "propuestas/porto/salida/pieza-1.png"),
            makeFile("pieza-1.png", "image/png", "2026-11-16T14:01:00.000Z", "propuestas/cancun/salida/pieza-1.png"),
            makeFile("playa.jpg", "image/jpeg", "2026-11-16T14:02:00.000Z", "referencias/playa.jpg"),
          ],
        },
      ],
    }),
  );
  assert.equal(twoPlatesAndRefs.featured?.kind, "plates");
  assert.equal(twoPlatesAndRefs.olderGroups.length, 2);
});

test("undoSummary formats plate counts, images, file counts, empty results, and fallback", () => {
  const works: Work[] = [
    makeWork({
      id: "w1",
      messages: [
        {
          id: "m-plates",
          role: "assistant",
          text: "Listo.",
          results: [
            makeFile("todas.png"),
            makeFile("pieza-1.png"),
            makeFile("pieza-2.png"),
            makeFile("pieza-3.png"),
            makeFile("pieza-4.png"),
            makeFile("piezas.pdf", "application/pdf"),
          ],
        },
        {
          id: "m-single",
          role: "assistant",
          text: "PDF.",
          results: [makeFile("cotizacion.pdf", "application/pdf")],
        },
        {
          id: "m-images",
          role: "assistant",
          text: "Fotos.",
          results: [makeFile("foto-a.png"), makeFile("foto-b.png")],
        },
        {
          id: "m-single-image",
          role: "assistant",
          text: "Foto.",
          results: [makeFile("foto.png")],
        },
        {
          id: "m-image-pdf",
          role: "assistant",
          text: "Foto y PDF.",
          results: [makeFile("foto.png"), makeFile("resumen.pdf", "application/pdf")],
        },
        {
          id: "m-plates-extra",
          role: "assistant",
          text: "Placas y extra.",
          results: [
            makeFile("pieza-1.png"),
            makeFile("pieza-2.png"),
            makeFile("portada.png"),
          ],
        },
        {
          id: "m-empty",
          role: "assistant",
          text: "Sin archivos.",
          results: [],
        },
        {
          id: "m-multi-pdf",
          role: "assistant",
          text: "Dos PDFs.",
          results: [
            makeFile("uno.pdf", "application/pdf"),
            makeFile("dos.pdf", "application/pdf"),
          ],
        },
      ],
    }),
  ];

  assert.equal(groupDeliverableBatches(works[0], "m-plates").featured?.kind, "plates");
  assert.equal(groupDeliverableBatches(works[0], "m-single").featured?.kind, "file");
  assert.equal(groupDeliverableBatches(works[0], "m-images").featured?.kind, "images");
  assert.equal(groupDeliverableBatches(works[0], "m-single-image").featured?.kind, "images");
  assert.equal(groupDeliverableBatches(works[0], "m-image-pdf").featured?.kind, "file");
  assert.equal(groupDeliverableBatches(works[0], "m-plates-extra").featured?.kind, "plates");
  assert.equal(groupDeliverableBatches(works[0], "m-multi-pdf").featured?.kind, "file");

  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-plates" }, works),
    "Se cambiaron 4 placas",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-single" }, works),
    "Se cambió 1 archivo",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-images" }, works),
    "Se cambiaron 2 imágenes",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-single-image" }, works),
    "Se cambió 1 imagen",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-image-pdf" }, works),
    "Se cambiaron 2 archivos",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-plates-extra" }, works),
    "Se cambiaron 2 placas",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-empty" }, works),
    "",
  );
  assert.equal(
    undoSummary({ workId: "w1", messageId: "m-multi-pdf" }, works),
    "Se cambiaron 2 archivos",
  );
  assert.equal(
    undoSummary({ workId: "w1" }, works),
    "Hubo cambios en los archivos",
  );
  assert.equal(
    undoSummary({ workId: "missing", messageId: "m-plates" }, works),
    "Hubo cambios en los archivos",
  );
});

test("web UI source avoids forbidden technical words", async () => {
  const entries = await readdir("web/src");
  for (const entry of entries) {
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    const text = await readFile(join("web/src", entry), "utf8");
    assert.doesNotMatch(text, /\bmotor\b/i, `web/src/${entry} should not mention "motor"`);
    assert.doesNotMatch(text, /archivo\s+JSON/i, `web/src/${entry} should not mention "archivo JSON"`);
    assert.doesNotMatch(text, /\bservidor\b/i, `web/src/${entry} should not mention "servidor"`);
  }
  const picker = await readFile(join("web/src", "model-picker.tsx"), "utf8");
  assert.doesNotMatch(picker, /razonamiento/i);
});
