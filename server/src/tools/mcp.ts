import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgencyFiles } from './paths';
import { traer } from './fetch';
import { controlar } from './check';
import { dibujar } from './draw';

const workspace = process.argv[2];
if (!workspace) throw new Error('Falta la carpeta de la agencia.');
const files = new AgencyFiles(workspace);
const allowedUrls = process.argv[3];
if (!allowedUrls) throw new Error('Falta la lista de links de la usuaria.');
const server = new McpServer({ name: 'bitacora-turismo', version: '1.0.0' });
const result = async (run: () => Promise<unknown>) => {
  try {
    const value = await run();
    return { isError: !!value && typeof value === 'object' && 'ok' in value && value.ok === false, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }
  catch (e) { return { isError: true, content: [{ type: 'text' as const, text: String(e) }] }; }
};
server.registerTool('traer', { description: 'Guardá el texto y las fotos del link que la usuaria escribió en su pedido. Si no está autorizado, pedile que pegue el link. Sin url, agregá notes al final de la fuente existente.', inputSchema: { url: z.string().url().optional(), destination: z.string().min(1), notes: z.string().max(50000).optional() } }, input => result(() => traer(files, input, {allowedUrls})));
server.registerTool('controlar', { description: 'Controlá todos los números visibles del HTML contra las líneas citadas en data-cites y guardá un informe.', inputSchema: { html: z.string(), source: z.string(), report: z.string(), rules: z.string().optional() } }, input => result(() => controlar(files, input)));
server.registerTool('dibujar', { description: 'Dibujá las piezas data-piece de un HTML local a PNG, PDF y una vista conjunta. No ejecuta scripts de la página.', inputSchema: { html: z.string(), destination: z.string(), width: z.number().int().min(100).max(4000).default(1080), height: z.number().int().min(100).max(4000).default(1920) } }, input => result(() => dibujar(files, input)));
await server.connect(new StdioServerTransport());
