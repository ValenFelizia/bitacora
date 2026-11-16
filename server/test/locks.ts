import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
export async function lockForWriting(path: string, sharing: 'Read' | 'None' = 'Read', timeoutMs = 30000) {
  const child = spawn(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';$s=[System.IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'ReadWrite', '${sharing}');[Console]::WriteLine('LOCKED');[Console]::ReadLine()|Out-Null;$s.Dispose()`], { windowsHide: true });
  const exited = once(child, 'close');
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Lock fixture timed out after ${timeoutMs}ms waiting for PowerShell lock${stderr ? `: ${stderr.trim()}` : ''}`));
      }, timeoutMs);
      const onStderr = (b: Buffer) => {
        stderr += String(b);
      };
      const onData = (b: Buffer) => {
        stdout += String(b);
        if (stdout.includes('LOCKED')) {
          cleanup();
          if (stderr.trim()) {
            reject(new Error(`Lock fixture reported errors during setup: ${stderr.trim()}`));
            return;
          }
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
      child.stderr.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onExit);
    });
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
  return async () => { child.stdin.end('\n'); await exited; };
}
