import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ServerResponse } from "node:http";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function desktopAssets(root: string) {
  const assets = new Map<string, { type: string; body: Buffer }>();
  async function load(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const url = prefix + encodeURIComponent(entry.name);
      if (entry.isDirectory()) await load(path, url + "/");
      const type = types[extname(entry.name)];
      if (type && entry.isFile()) assets.set(url, { type, body: await readFile(path) });
    }
  }
  await load(root, "/");
  if (!assets.has("/index.html")) throw new Error("Missing desktop frontend");
  return (pathname: string, method: string | undefined, response: ServerResponse, port: number) => {
    const asset = assets.get(pathname === "/" ? "/index.html" : pathname);
    if (!asset || (method !== "GET" && method !== "HEAD")) return false;
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Content-Length": asset.body.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(method === "HEAD" ? undefined : asset.body);
    return true;
  };
}
