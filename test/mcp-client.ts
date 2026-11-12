import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'dist', 'mcp', 'cli.js');

/** Spawn the built orbyt-mcp over stdio and connect an MCP client to it. */
export async function connect(args: string[] = ['--backend', 'gpu', '--memory', '256'], cwd = ROOT) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, ...args], cwd, stderr: 'pipe' });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: 'orbyt-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}
