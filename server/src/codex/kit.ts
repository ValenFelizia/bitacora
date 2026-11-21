import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { allowedUrlsPath } from '../allowed-urls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse, stringify } from 'smol-toml';

export async function registerKit(home: string, workspace: string, mcpEntry?: string, data = dirname(home)) {
  const path = join(home, 'config.toml');
  let config: Record<string, any> = {};
  try { config = parse(await readFile(path, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  config.mcp_servers ??= {};
  const launch = mcpEntry ? [mcpEntry] : [
    '--import',
    pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
    fileURLToPath(new URL('../tools/mcp.ts', import.meta.url)),
  ];
  config.mcp_servers.bitacora = {
    command: process.execPath,
    args: [...launch, workspace, allowedUrlsPath(data)],
    enabled_tools: ['traer', 'controlar', 'dibujar'],
    tools: Object.fromEntries(['traer', 'controlar', 'dibujar'].map(name => [name, {approval_mode: 'approve'}])),
    tool_timeout_sec: 120,
  };
  await writeFile(path, stringify(config), 'utf8');
}
