import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export const MCP_TEST_TIMEOUT_MS = 180000;

function withTimeoutContext(label: string, timeoutMs: number, error: unknown): Error {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === ErrorCode.RequestTimeout && (error instanceof McpError || error instanceof Error)) {
    return new Error(`${label} timed out after ${timeoutMs}ms`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function connectKitClient(client: Client, transport: Transport, timeoutMs = MCP_TEST_TIMEOUT_MS) {
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    throw withTimeoutContext('MCP client connect', timeoutMs, error);
  }
}

export async function listKitTools(client: Client, timeoutMs = MCP_TEST_TIMEOUT_MS) {
  try {
    return await client.listTools(undefined, { timeout: timeoutMs });
  } catch (error) {
    throw withTimeoutContext('MCP listTools', timeoutMs, error);
  }
}

export async function callKitTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = MCP_TEST_TIMEOUT_MS,
) {
  try {
    return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  } catch (error) {
    throw withTimeoutContext(`MCP tool "${name}"`, timeoutMs, error);
  }
}
