import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
export async function lockForWriting(path: string, sharing: 'Read' | 'None' = 'Read', timeoutMs = 30000) {
  const child = spawn(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$s=[System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'ReadWrite', '${sharing}');[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null;$s.Dispose()`], { windowsHide: true });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Lock fixture timed out after ${timeoutMs}ms waiting for PowerShell lock${stderr ? `: ${stderr.trim()}` : ''}`));
      }, timeoutMs);
      const onData = (b: Buffer) => {
        if (String(b).includes('LOCKED')) {
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Lock fixture exited prematurely with status ${code}, signal ${signal}${stderr ? `: ${stderr.trim()}` : ''}`));
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', b => { stderr += String(b); });
      child.once('error', onError);
      child.once('exit', onExit);
    });
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
  return async () => { child.stdin.end('\n'); await exited; };
}
