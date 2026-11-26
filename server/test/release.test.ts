import assert from "node:assert/strict";
import { test } from "node:test";
import { makeManifest } from "../../scripts/release.mjs";

test("latest.json points to the versioned setup and contains the signature for its architecture", () => {
  assert.deepEqual(makeManifest({
    version: "0.2.1",
    notes: "Mejoras en Bitácora.",
    date: new Date("2026-11-26T12:00:00.000Z"),
    arch: "x64",
    installer: "Bitacora_0.2.1_x64-setup.exe",
    signature: "test-signature\r\n",
  }), {
    version: "0.2.1",
    notes: "Mejoras en Bitácora.",
    pub_date: "2026-11-26T12:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        url: "https://github.com/ValenFelizia/bitacora/releases/download/v0.2.1/Bitacora_0.2.1_x64-setup.exe",
        signature: "test-signature",
      },
    },
  });
});
