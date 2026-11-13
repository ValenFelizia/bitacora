import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Absolute paths: under Git Bash, `whoami` on PATH is the GNU one and rejects `/user`.
const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const whoami = join(system32, 'whoami.exe');
const icacls = join(system32, 'icacls.exe');

export function denyRead(directory: string) {
  const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)![0];
  execFileSync(icacls, [directory, '/deny', `*${sid}:(OI)(CI)(RX)`], { stdio: 'pipe' });
  return () => execFileSync(icacls, [directory, '/remove:d', `*${sid}`], { stdio: 'pipe' });
}
