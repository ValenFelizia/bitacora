import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FetchOptions } from './fetch';
import { z } from 'zod';
import { AgencyFiles } from './paths';
import { traer } from './fetch';
import { controlar } from './check';
import { dibujar } from './draw';
import { Templates, templateMetadata } from '../templates';
import { inspectPdf, PDF_PAGE_BATCH } from './pdf';

export function createTourismServer(workspace: string, allowedUrls: string, testOptions: Pick<FetchOptions, 'testOrigin'> = {}) {
const files = new AgencyFiles(workspace);
const server = new McpServer({ name: 'bitacora-turismo', version: '1.0.0' });
const result = async (run: () => Promise<unknown>) => {
  try {
    const value = await run();
    return { isError: !!value && typeof value === 'object' && 'ok' in value && value.ok === false, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }
  catch (e) { return { isError: true, content: [{ type: 'text' as const, text: String(e) }] }; }
};
server.registerTool('traer', { description: 'Guardá el texto y las fotos del link que la usuaria escribió en su pedido. Si no está autorizado, pedile que pegue el link. Sin url, agregá notes al final de la fuente existente.', inputSchema: { url: z.string().url().optional(), destination: z.string().min(1), notes: z.string().max(50000).optional() } }, input => result(() => traer(files, input, {allowedUrls,...testOptions})));
server.registerTool('controlar', { description: 'Controlá todos los números visibles contra data-cites: número de línea de source, o "m:línea" de brand para datos de la agencia. Guardá un informe con archivo y línea.', inputSchema: { html: z.string(), source: z.string(), report: z.string(), brand: z.string().optional(), rules: z.string().optional() } }, input => result(() => controlar(files, input)));
server.registerTool('dibujar', { description: 'Dibujá las piezas data-piece de un HTML local a PNG, PDF y una vista conjunta. No ejecuta scripts de la página.', inputSchema: { html: z.string(), destination: z.string(), width: z.number().int().min(100).max(4000).default(1080), height: z.number().int().min(100).max(4000).default(1920) } }, input => result(() => dibujar(files, input)));
const templates = new Templates(files);
const templatePaths = z.array(z.string().min(1)).min(1).max(10);
server.registerTool('listar_plantillas', {
  description: 'Consultá las plantillas de la carpeta antes de armar una pieza, cotización o documento. Devuelve el nombre, el uso y el identificador de cada plantilla.',
}, () => result(() => templates.list()));
server.registerTool('leer_plantilla', {
  description: 'Buscá una plantilla por identificador. Devuelve los archivos guardados dentro de la carpeta de trabajo, en orden (primero el archivo principal). Para un PDF usá mirar_pdf.',
  inputSchema: { id: z.uuid() },
}, ({ id }) => result(() => templates.describe(id)));
server.registerTool('sumar_plantilla', {
  description: 'Guardá una plantilla que pidió la usuaria. Pasá las rutas relativas, con el archivo principal primero. Para una cotización convertida, pasá primero el HTML editable sin datos del cliente y agregá el PDF original como referencia. Si hay recursos, usá referencias a archivos vecinos e incluilos.',
  inputSchema: { ...templateMetadata, paths: templatePaths },
}, ({ name, purpose, paths }) => result(async () =>
  templates.add({ name, purpose, origin: 'agent' }, await templates.fromPaths(paths))));
server.registerTool('actualizar_plantilla', {
  description: 'Cambiá el nombre o uso, o reemplazá los archivos de una plantilla. Si enviás paths, incluí todos los archivos que deban quedar, con el principal primero.',
  inputSchema: { id: z.uuid(), name: templateMetadata.name.optional(), purpose: templateMetadata.purpose.optional(), paths: templatePaths.optional() },
}, ({ id, name, purpose, paths }) => result(async () =>
  templates.update(id, { ...(name === undefined ? {} : { name }), ...(purpose === undefined ? {} : { purpose }) },
    paths && { kind: 'bundle', files: await templates.fromPaths(paths) })));
server.registerTool('mirar_pdf', {
  description: 'Leé el texto y mirá imágenes de las páginas de un PDF dentro de la carpeta de trabajo. Devuelve también sus medidas en píxeles para dibujar y la próxima página si quedan más.',
  inputSchema: { path: z.string(), start: z.number().int().min(1).default(1), count: z.number().int().min(1).max(PDF_PAGE_BATCH).default(1) },
}, async ({ path, start, count }) => {
  try {
    const { pages, ...summary } = await inspectPdf(files, path, start, count);
    return { content: [
      { type: 'text' as const, text: JSON.stringify({ ...summary, pages: pages.map(({ image, ...page }) => page) }) },
      ...pages.map(({ image }) => ({ type: 'image' as const, mimeType: 'image/png', data: image.toString('base64') })),
    ] };
  } catch (error) { return result(async () => { throw error; }); }
});
return server;
}
