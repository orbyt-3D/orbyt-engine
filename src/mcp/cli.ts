import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs, USAGE } from './args.js';
import { BrowserHost } from './host.js';
import { createOrbytServer, VERSION } from './server.js';

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  if (opts.help) return void process.stdout.write(USAGE);
  if (opts.version) return void process.stdout.write(`${VERSION}\n`);

  // stdout is the MCP channel — logs go to stderr only.
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const host = new BrowserHost({ backend: opts.backend, memory: opts.memory, browserPath: opts.browser, log });
  const { server } = createOrbytServer({ host });
  const shutdown = async () => {
    await host.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
  await server.connect(new StdioServerTransport());
  log(`orbyt-mcp ${VERSION} ready on stdio (backend ${opts.backend}, memory ${opts.memory} MiB)`);
}

main().catch((e) => {
  process.stderr.write(`orbyt-mcp: ${e?.stack ?? e}\n`);
  process.exit(1);
});
