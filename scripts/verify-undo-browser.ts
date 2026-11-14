// Interactive fixture for the shared browser, using only synthetic files and FakeEngine.
import { createInterface } from 'node:readline';
import { undoFixture } from './undo-rework-fixture';
const fixture = await undoFixture();
console.log('Fixture ready on 5184 / 4328. Commands: manual, lock, unlock, Enter to close.');
createInterface({ input: process.stdin }).on('line', line => { void (async () => {
  if (line === 'manual') await fixture.manual();
  else if (line === 'lock') await fixture.lock();
  else if (line === 'unlock') await fixture.unlock();
  else { await fixture.close(); process.exit(0); }
  console.log('Done:', line);
})(); });
