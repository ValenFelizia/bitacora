// Test-only stdio entry: one exact origin owned by the integration fixture.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTourismServer } from '../src/tools/mcp-server';
await createTourismServer(process.argv[2],process.argv[3],{testOrigin:process.argv[4]}).connect(new StdioServerTransport());
