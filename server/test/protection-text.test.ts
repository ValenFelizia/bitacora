import { test } from "node:test";
import assert from "node:assert/strict";
import { protectionText, protectionWarning } from "../../web/src/protection-text";

test("the warning says in plain words what this computer cannot protect", () => {
  const warning = protectionWarning({
    allowed: true,
    status: "ready",
    readBlock: false,
    detail: "windowsSandbox/readiness=ready; windows.sandbox=elevated; readBlock=off",
  });
  assert.match(warning, /no puedo impedir que el agente lea archivos fuera de tu carpeta/);
  assert.match(warning, /no puede cambiarlos ni borrarlos/);
  // No technical terms: the user is not a programmer.
  assert.doesNotMatch(warning, /MXC|sandbox|perfil|backend|API|elevated/i);
});

test("there is no warning when the read block is in place or still unknown", () => {
  assert.equal(protectionWarning({ allowed: true, status: "ready", readBlock: true, detail: "" }), "");
  assert.equal(protectionWarning({ allowed: false, status: "needed", detail: "" }), "");
});

test("a refused read block is a failure, not a warning", () => {
  const safety = {
    allowed: false,
    status: "failed" as const,
    issue: "readBlock" as const,
    detail: "permissionProfile/list does not offer agencia",
  };
  assert.equal(protectionWarning(safety), "");
  assert.match(protectionText(safety), /No pude activar el bloqueo/);
});
