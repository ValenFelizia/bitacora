import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { serve } from '../server/src/server';
import { FakeEngine } from '../server/test/fake-engine';
import { lockForWriting } from '../server/test/locks';
export async function undoFixture() {
  await mkdir('.local', { recursive: true }); const base = await mkdtemp(resolve('.local/undo-rework-browser-'));
  const workspace = join(base, 'agency'); await mkdir(workspace); await writeFile(join(workspace, 'documento.docx'), 'original');
  const engine = new FakeEngine(); let unlock: (() => Promise<void>) | undefined;
  engine.send = async conversationId => {
    await writeFile(join(workspace, 'documento.docx'), 'cambio del pedido');
    await writeFile(join(workspace, 'propuesta.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    engine.emit({ type: 'message', conversationId, id: 'reply', text: 'Te preparé una propuesta de prueba.', delta: false });
    engine.emit({ type: 'finished', conversationId, status: 'completed' });
  };
  process.env.BITACORA_PORT = '4328'; process.env.BITACORA_WEB_PORT = '5184';
  const server = await serve(engine, join(base, 'data'), 4328, 'http://127.0.0.1:5184', workspace);
  const vite = await createServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web') }); await vite.listen();
  return {
    workspace,
    manual: () => writeFile(join(workspace, 'foto personal.jpg'), 'foto agregada a mano'),
    lock: async () => { unlock ||= await lockForWriting(join(workspace, 'documento.docx')); },
    unlock: async () => { await unlock?.(); unlock = undefined; },
    partial: () => {
      // Deterministic late failure, after the new image was already reverted.
      (server.app as any).backups.io.beforeMutation = async (path: string, kind: string) => {
        if (path === 'documento.docx' && kind === 'rename') throw new Error('Fixture: later file cannot be replaced');
      };
    },
    close: async () => { await unlock?.(); await vite.close(); await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
  };
}
