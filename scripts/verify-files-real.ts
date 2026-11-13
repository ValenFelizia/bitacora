// Owner-authorized real check: at most two short requests; preserves prueba data.
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { CodexEngine } from '../server/src/codex/engine';
import { WorkspaceFiles } from '../server/src/workspace-files';
import { App } from '../server/src/app';
if (process.env.BITACORA_REAL_CHECK_ALLOWED !== 'issue5-two-requests') throw new Error('Real check disabled: requires explicit authorization for two requests.');
const base = join(process.env.LOCALAPPDATA!, 'Bitacora-dev', 'prueba');
const engine = new CodexEngine({ home: join(base, 'datos', 'codex'), workspace: join(base, 'carpeta') });
const app = new App(engine, join(base, 'datos'), () => {}, undefined, new WorkspaceFiles(join(base, 'carpeta')));
const evidence: Record<string, unknown> = { requests: 0 };
try {
  await app.start();
  const snapshot = app.snapshot();
  evidence.connected = snapshot.account.connected;
  evidence.protected = snapshot.engine.safety.allowed;
  if (!snapshot.account.connected || !snapshot.engine.safety.allowed || snapshot.works.some(w => w.busy)) {
    evidence.skipped = 'Account disconnected, protection unavailable, or work already running; no login or preparation requested.';
  } else {
    const wait = async () => {
      const deadline = Date.now() + 180000;
      while (app.snapshot().works.some(w => w.busy)) {
        if (Date.now() > deadline) throw new Error('Real request timed out; no retry');
        await new Promise(r => setTimeout(r, 250));
      }
    };
    evidence.requests = 1;
    await app.command({ type: 'send', text: 'Prueba breve de Bitácora: describí en una sola oración la imagen adjunta. No modifiques archivos.', attachments: [{ name: 'pantalla de prueba.png', data: (await readFile(resolve('docs/verification/issue5/drop.png'))).toString('base64') }] }, () => {});
    const workId = app.snapshot().works[0].id;
    await wait();
    let work = app.snapshot().works.find(w => w.id === workId)!;
    evidence.imageReply = work.messages.filter(m => m.role === 'assistant').map(m => m.text);
    evidence.firstProblem = work.problem || null;
    if (!work.problem) {
      evidence.requests = 2;
      await app.command({ type: 'send', workId, text: 'Segunda y última prueba: con un comando creá issue5-prueba-verde.png, un PNG simple de 200 por 120 píxeles verdes. Usá lo que ya esté instalado, sin instalar nada ni generar imágenes con IA. Respondé en una oración.' }, () => {});
      await wait();
      work = app.snapshot().works.find(w => w.id === workId)!;
      evidence.results = work.messages.flatMap(m => m.results || []).map(f => ({ name: f.name, mime: f.mime }));
      evidence.secondProblem = work.problem || null;
    }
  }
} catch (error) { evidence.error = String(error); }
finally {
  await app.close();
  await writeFile(resolve('docs/verification/issue5/real-check.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify(evidence));
}
