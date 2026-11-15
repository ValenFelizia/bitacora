// A real process exit, not a caught exception/rollback. No agent process is used.
import { rename } from 'node:fs/promises';
import { Backups, BACKUP_LIMITS } from '../src/backups';
const [root, data, receipt, cutText, mode = 'undo'] = process.argv.slice(2);
const cut = Number(cutText); let operations = 0;
const b = new Backups(root, data, BACKUP_LIMITS, undefined, { rename, afterStep: async () => {}, afterOperation: async label => {
  operations++; process.stdout.write(JSON.stringify({ operations, label }) + '\n');
  if (operations === cut) process.exit(73);
} });
await b.initialize(receipt);
if (mode === 'discard') await b.discard(b.target!.id); else await b.undo(b.target!.id);
process.stdout.write(JSON.stringify({ total: operations }) + '\n');
