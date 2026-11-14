import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
export async function lockForWriting(path: string) {
  const child = spawn(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$s=[System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'ReadWrite', 'Read');[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null;$s.Dispose()`], { windowsHide: true });
  const exited = once(child, 'exit');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lock fixture timed out')), 10000);
    child.stdout.on('data', b => { if (String(b).includes('LOCKED')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', b => { clearTimeout(timer); reject(new Error(String(b))); });
    child.once('error', reject);
  });
  return async () => { child.stdin.end('\n'); await exited; };
}
