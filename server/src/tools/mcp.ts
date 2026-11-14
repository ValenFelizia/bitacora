import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTourismServer } from './mcp-server';
const workspace = process.argv[2], allowedUrls = process.argv[3];
if (!workspace || !allowedUrls) throw new Error('Falta la carpeta de la agencia o la lista de links de la usuaria.');
// No test permissions, CLI switches or environment flags in the production entry.
await createTourismServer(workspace,allowedUrls).connect(new StdioServerTransport());
