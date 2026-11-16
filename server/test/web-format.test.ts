import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileRef, Work } from "../src/contracts";
import { formatTime, formatWorkDate, groupDeliverables } from "../../web/src/format";

const makeFile = (name: string, mime = "image/png", createdAt = "2026-11-16T14:05:00.000Z"): FileRef => ({
  id: name,
  name,
  mime,
  path: name,
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

test("groupDeliverables promotes multi-plate batch to hero and leaves older files below", () => {
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

  const grouped = groupDeliverables(work);
  assert.ok(grouped.featured);
  assert.equal(grouped.featured.title, "Porto de Galinhas, febrero");
  assert.match(grouped.featured.meta, /^4 placas/);
  assert.deepEqual(
    grouped.featured.plates.map((p) => p.name),
    ["pieza-1.png", "pieza-2.png", "pieza-3.png", "pieza-4.png"],
  );
  assert.equal(grouped.featured.primary.name, "pieza-1.png");
  assert.deepEqual(
    grouped.older.map((f) => f.name),
    ["piezas.pdf", "Cotización.pdf"],
  );
});

test("groupDeliverables handles single deliverable and empty works", () => {
  assert.deepEqual(groupDeliverables(undefined), { older: [] });
  assert.deepEqual(groupDeliverables(makeWork()), { older: [] });

  const single = groupDeliverables(
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
  assert.equal(single.older.length, 0);
});

test("web UI source does not contain the word motor", async () => {
  const entries = await readdir("web/src");
  for (const entry of entries) {
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    const text = await readFile(join("web/src", entry), "utf8");
    assert.doesNotMatch(text, /\bmotor\b/i, `web/src/${entry} should not mention "motor"`);
  }
});
