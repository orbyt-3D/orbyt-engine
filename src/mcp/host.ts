/**
 * RenderHost — owns a headless Chromium page running dist/runtime/orbyt-runtime.js (Flare/Bake),
 * and serves it the scene's files over an intercepted origin. Launched lazily on first render.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import type { SceneDoc } from '../doc.js';
import type { Vec3 } from '../parts.js';

export type Backend = 'gpu' | 'cpu';

export interface HostOptions {
  backend: Backend;
  /** Memory budget in MiB (renderer JS heap + max frame size + max model size). */
  memory: number;
  /** Explicit Chromium/Chrome/Edge executable. */
  browserPath?: string;
  log?: (msg: string) => void;
}

export interface RenderArgs {
  width: number;
  height: number;
  mode?: 'beauty' | 'normals';
  engine?: 'flare' | 'bake';
  samples?: number;
  timeoutMs?: number;
  eye?: Vec3;
  target?: Vec3;
  fov?: number;
  time?: number;
}

export interface InspectResult {
  parts: { id: string; center: Vec3; size: Vec3; min: Vec3 | null; max: Vec3 | null; meshes: number; triangles: number; materials: string[] }[];
  bounds: { min: Vec3; max: Vec3; center: Vec3 } | null;
}

export interface GpuInfo {
  webgl2: boolean;
  vendor: string;
  renderer: string;
  maxTextureSize: number;
  backend: Backend;
  browser: string;
}

/** What the server needs from a renderer. The real one is `BrowserHost`; tests can pass a fake. */
export interface RenderHostLike {
  readonly limits: { maxPixels: number; maxFileBytes: number };
  info(): Promise<GpuInfo>;
  render(doc: SceneDoc, files: string[], args: RenderArgs): Promise<{ png: string; ms: number; samples?: number; camera?: { eye: Vec3; fov: number } }>;
  renderViews(doc: SceneDoc, files: string[], args: { width: number; height: number; mode?: 'beauty' | 'normals' }): Promise<{ png: string }>;
  inspect(doc: SceneDoc, files: string[]): Promise<InspectResult>;
  exportGlb(doc: SceneDoc, files: string[]): Promise<Uint8Array>;
  close(): Promise<void>;
}

const ORIGIN = 'https://orbyt.render';

/** Locate dist/runtime/orbyt-runtime.js by walking up to the package root. */
export function findRuntimeBundle(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'dist', 'runtime', 'orbyt-runtime.js');
    if (existsSync(candidate)) return candidate;
    const sibling = join(dir, 'runtime', 'orbyt-runtime.js');
    if (existsSync(sibling)) return sibling;
    dir = dirname(dir);
  }
  throw new Error('orbyt-mcp: dist/runtime/orbyt-runtime.js not found — run `npm run build` first');
}

/** Chromium-family executables to try, most specific first. */
export function browserCandidates(explicit?: string): { label: string; executablePath?: string; channel?: string }[] {
  const out: { label: string; executablePath?: string; channel?: string }[] = [];
  const env = explicit ?? process.env.ORBYT_BROWSER;
  if (env) out.push({ label: env, executablePath: env });
  out.push({ label: 'playwright chromium' });
  out.push({ label: 'chrome', channel: 'chrome' });
  out.push({ label: 'msedge', channel: 'msedge' });
  // any Chromium already downloaded by another Playwright version
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'));
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const exe =
        process.platform === 'win32'
          ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
          : process.platform === 'darwin'
            ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
            : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
      for (const e of exe) {
        const p = join(cache, d, e);
        if (existsSync(p)) out.push({ label: `${d}`, executablePath: p });
      }
    }
  }
  return out;
}

export function backendArgs(backend: Backend): string[] {
  return backend === 'cpu'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
    : ['--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl', '--use-angle=default'];
}

export function limitsFor(memoryMiB: number) {
  // ~64 bytes/pixel covers the HDR target, MSAA, bloom mips and the PNG readback.
  return { maxPixels: Math.floor((memoryMiB * 1024 * 1024) / 64), maxFileBytes: Math.floor((memoryMiB * 1024 * 1024) / 2) };
}

export class BrowserHost implements RenderHostLike {
  readonly limits: { maxPixels: number; maxFileBytes: number };
  private browser: Browser | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private allowed = new Set<string>();
  private browserLabel = '';
  private backend: Backend;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly options: HostOptions) {
    this.backend = options.backend;
    this.limits = limitsFor(options.memory);
  }

  private log(msg: string) {
    this.options.log?.(msg);
  }

  private async launch(backend: Backend): Promise<Browser> {
    const { chromium } = await import('playwright-core');
    const errors: string[] = [];
    for (const c of browserCandidates(this.options.browserPath)) {
      try {
        const browser = await chromium.launch({
          headless: true,
          executablePath: c.executablePath,
          channel: c.channel,
          args: [...backendArgs(backend), `--js-flags=--max-old-space-size=${Math.max(64, this.options.memory)}`],
        });
        this.browserLabel = `${c.label} ${browser.version()}`;
        return browser;
      } catch (e) {
        errors.push(`${c.label}: ${String((e as Error).message).split('\n')[0]}`);
      }
    }
    throw new Error(
      `orbyt-mcp could not start a Chromium-based browser for rendering.\nTried:\n  ${errors.join('\n  ')}\n` +
        'Install Chrome or Edge, run `npx playwright install chromium`, or set ORBYT_BROWSER=/path/to/chrome.',
    );
  }

  private async openPage(backend: Backend): Promise<Page> {
    const runtime = await readFile(findRuntimeBundle(), 'utf8');
    this.browser = await this.launch(backend);
    const page = await this.browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('pageerror', (e) => this.log(`[page error] ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.log(`[page ${m.type()}] ${m.text()}`);
    });
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><title>orbyt render</title><body style="margin:0;background:#060b10"><script src="/orbyt-runtime.js"></script></body>',
        });
      }
      if (url.pathname === '/orbyt-runtime.js') return route.fulfill({ contentType: 'text/javascript', body: runtime });
      if (url.pathname.startsWith('/files/')) {
        const file = decodeURIComponent(url.pathname.slice('/files/'.length));
        if (!this.allowed.has(file)) return route.fulfill({ status: 403, body: 'not part of the scene' });
        try {
          return route.fulfill({ status: 200, body: await readFile(file), headers: { 'access-control-allow-origin': '*' } });
        } catch {
          return route.fulfill({ status: 404, body: 'not found' });
        }
      }
      return route.fulfill({ status: 404, body: 'not found' });
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => (globalThis as { orbytRuntime?: { ready?: boolean } }).orbytRuntime?.ready === true, null, { timeout: 30_000 });
    return page;
  }

  private async getPage(): Promise<Page> {
    if (this.page) return this.page;
    if (!this.starting) {
      this.starting = (async () => {
        let page = await this.openPage(this.backend);
        let info = await page.evaluate(() => (globalThis as never as { orbytRuntime: { info(): GpuInfo } }).orbytRuntime.info()).catch(() => null);
        if (!info?.webgl2 && this.backend === 'gpu') {
          this.log('orbyt-mcp: GPU WebGL2 unavailable in headless browser, falling back to --backend cpu (SwiftShader)');
          await this.browser?.close();
          this.backend = 'cpu';
          page = await this.openPage('cpu');
          info = await page.evaluate(() => (globalThis as never as { orbytRuntime: { info(): GpuInfo } }).orbytRuntime.info());
        }
        if (!info?.webgl2) throw new Error('orbyt-mcp: WebGL2 is not available in the headless browser');
        this.log(`orbyt-mcp: rendering with ${info.renderer} (${this.backend}) in ${this.browserLabel}`);
        this.page = page;
        return page;
      })().catch((e) => {
        this.starting = null;
        throw e;
      });
    }
    return this.starting;
  }

  /** Serialise calls into the single page. */
  private run<T>(files: string[], fn: (page: Page) => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      for (const f of files) {
        const st = statSync(f, { throwIfNoEntry: false });
        if (!st) throw new Error(`File not found: ${f}`);
        if (st.size > this.limits.maxFileBytes)
          throw new Error(`${f} is ${(st.size / 1048576).toFixed(1)} MiB, over the --memory budget (${(this.limits.maxFileBytes / 1048576).toFixed(0)} MiB per file). Restart with a larger --memory.`);
        this.allowed.add(resolve(f));
      }
      return fn(await this.getPage());
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async info(): Promise<GpuInfo> {
    return this.run([], async (page) => ({
      ...(await page.evaluate(() => (globalThis as never as { orbytRuntime: { info(): Omit<GpuInfo, 'backend' | 'browser'> } }).orbytRuntime.info())),
      backend: this.backend,
      browser: this.browserLabel,
    }));
  }

  render(doc: SceneDoc, files: string[], args: RenderArgs) {
    return this.run(files, (page) =>
      page.evaluate(([d, a]) => (globalThis as never as { orbytRuntime: { render: Function } }).orbytRuntime.render(d, a), [doc, args] as const),
    ) as ReturnType<RenderHostLike['render']>;
  }

  renderViews(doc: SceneDoc, files: string[], args: { width: number; height: number; mode?: 'beauty' | 'normals' }) {
    return this.run(files, (page) =>
      page.evaluate(([d, a]) => (globalThis as never as { orbytRuntime: { renderViews: Function } }).orbytRuntime.renderViews(d, a), [doc, args] as const),
    ) as Promise<{ png: string }>;
  }

  inspect(doc: SceneDoc, files: string[]) {
    return this.run(files, (page) =>
      page.evaluate((d) => (globalThis as never as { orbytRuntime: { inspect: Function } }).orbytRuntime.inspect(d), doc),
    ) as Promise<InspectResult>;
  }

  async exportGlb(doc: SceneDoc, files: string[]) {
    const b64 = (await this.run(files, (page) =>
      page.evaluate((d) => (globalThis as never as { orbytRuntime: { exportGlb: Function } }).orbytRuntime.exportGlb(d), doc),
    )) as string;
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
    this.starting = null;
  }
}
