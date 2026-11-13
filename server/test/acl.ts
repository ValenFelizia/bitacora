import { execFileSync } from 'node:child_process';
export function denyRead(directory: string) {
  const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)![0];
  execFileSync('icacls', [directory, '/deny', `*${sid}:(OI)(CI)(RX)`], { stdio: 'pipe' });
  return () => execFileSync('icacls', [directory, '/remove:d', `*${sid}`], { stdio: 'pipe' });
}
