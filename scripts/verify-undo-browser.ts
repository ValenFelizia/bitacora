// Interactive fixture for the shared browser, using only synthetic files and FakeEngine.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { serve } from '../server/src/server';
import { FakeEngine } from '../server/test/fake-engine';
await mkdir('.local', { recursive: true });
const base = await mkdtemp(resolve('.local/issue4-browser-'));
const workspace = join(base, 'agency'); const engine = new FakeEngine();
engine.send = async (conversationId) => {
  await writeFile(join(workspace, 'propuesta.txt'), 'Propuesta sintética');
  engine.emit({ type: 'message', conversationId, id: 'reply', text: 'Te preparé la propuesta.', delta: false });
  engine.emit({ type: 'finished', conversationId, status: 'completed' });
};
process.env.BITACORA_PORT = '4328'; process.env.BITACORA_WEB_PORT = '5184';
const server = await serve(engine, join(base, 'data'), 4328, 'http://127.0.0.1:5184', workspace);
const vite = await createServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web') }); await vite.listen();
console.log('Fixture ready on 5184 / 4328. Press Enter to close.');
process.stdin.once('data', () => { void (async () => { await vite.close(); await server.close(); await rm(base, { recursive: true, force: true }); process.exit(0); })(); });
