import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Fixed-size comparison, including malformed inputs. Never serialize this object.
const equal = (input: string, expected: Buffer) => {
  const valid = /^[a-f0-9]{64}$/.test(input);
  const candidate = valid ? Buffer.from(input, "hex") : Buffer.alloc(32);
  return timingSafeEqual(candidate, expected) && valid;
};
export function createSession(now = Date.now) {
  const secret = randomBytes(32);
  const code = randomBytes(32);
  const expires = now() + 120_000;
  let used = false;
  return {
    entryCode: code.toString("hex"),
    redeem(input: string) {
      const matches = equal(input, code);
      if (!matches || used || now() >= expires) return undefined;
      used = true;
      return `bitacora_session=${secret.toString("hex")}; HttpOnly; SameSite=Strict; Path=/`;
    },
    authenticated(req: Pick<IncomingMessage, "headers">) {
      const cookies = (req.headers.cookie || "").split(";").map(c => c.trim());
      const values = cookies.filter(c => c.startsWith("bitacora_session="));
      return equal(values.length === 1 ? values[0].slice("bitacora_session=".length) : "", secret);
    },
  };
}
// The fragment never travels in the GET request. Erase it before redeeming.
export const entryPage = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Entrar a Bitácora</title>
<p id="notice">Abriendo Bitácora…</p><script>
const code = location.hash.slice(1); history.replaceState(null, '', '/entry');
fetch('/entry', {method:'POST', headers:{'Content-Type':'text/plain'}, body:code})
.then(r => { if (!r.ok) throw Error(); location.replace('/'); })
.catch(() => { document.getElementById('notice').textContent = 'Esta entrada ya no sirve. Volvé a abrir Bitácora con la dirección nueva que aparece al iniciarla.'; });
</script></html>`;
