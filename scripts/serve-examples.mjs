// Tiny static server for the examples (no dependencies).
// Serves the repo root; "/server-hall.glb" and "/dusk.hdr" fall back to examples/assets/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 5173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.hdr': 'application/octet-stream', '.png': 'image/png', '.wasm': 'application/wasm', '.css': 'text/css' };

async function resolveFile(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^[\\/]+/, '');
  if (rel.startsWith('..')) return null;
  for (const p of [join(root, rel), join(root, 'examples', 'assets', rel)]) {
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) return p;
    if (s?.isDirectory()) {
      const idx = join(p, 'index.html');
      if (await stat(idx).catch(() => null)) return idx;
    }
  }
  return null;
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/') {
    res.writeHead(302, { location: '/examples/' });
    return res.end();
  }
  const file = await resolveFile(path);
  if (!file) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(file));
}).listen(port, () => console.log(`orbyt examples → http://localhost:${port}/examples/`));
