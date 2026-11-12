import type { Backend } from './host.js';

export interface CliOptions {
  backend: Backend;
  memory: number;
  browser?: string;
  help: boolean;
  version: boolean;
}

export const USAGE = `orbyt-mcp — MCP server for the orbyt 3D engine (stdio)

Usage: orbyt-mcp [--backend gpu|cpu] [--memory <MiB>] [--browser <path>]

  --backend gpu|cpu   gpu: hardware WebGL2 in headless Chromium (falls back to cpu if unavailable)
                      cpu: SwiftShader software rendering (slow, works everywhere)   [default: gpu]
  --memory <MiB>      renderer memory budget: JS heap, max frame size, max file size [default: 256]
  --browser <path>    Chromium/Chrome/Edge executable (or set ORBYT_BROWSER)
  -h, --help          show this help
  -v, --version       print the version
`;

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { backend: 'gpu', memory: 256, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--backend': {
        const v = value();
        if (v !== 'gpu' && v !== 'cpu') throw new Error(`--backend must be "gpu" or "cpu", got "${v}"`);
        o.backend = v;
        break;
      }
      case '--memory': {
        const v = Number(value());
        if (!Number.isFinite(v) || v < 32) throw new Error('--memory must be a number of MiB >= 32');
        o.memory = Math.floor(v);
        break;
      }
      case '--browser':
        o.browser = value();
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '-v':
      case '--version':
        o.version = true;
        break;
      default:
        throw new Error(`Unknown option ${raw}\n\n${USAGE}`);
    }
  }
  return o;
}
