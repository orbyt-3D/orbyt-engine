// Measures real gzip sizes (minified, tree-shaken with esbuild) for the README / website.
// Usage: npm run build && npm run size
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'orbyt-size-'));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function measure(name, code, external = []) {
  const entry = join(tmp, `${name}.js`);
  writeFileSync(entry, code);
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    external,
    absWorkingDir: root,
    nodePaths: [join(root, 'node_modules')],
    alias: { orbyt: join(root, 'dist', 'index.js') },
    logLevel: 'error',
  });
  const bytes = r.outputFiles[0].contents;
  return { name, min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

const rows = [
  await measure(
    'orbyt own code (Flare + Stage + parts, three external)',
    `import { Flare, createPrimitive } from 'orbyt'; new Flare(document.querySelector('canvas'), [createPrimitive('box')]).render();`,
    ['three', 'three/*'],
  ),
  await measure(
    'orbyt lit-box app (everything incl. three, bloom, PMREM)',
    `import { Flare, createPrimitive } from 'orbyt'; new Flare(document.querySelector('canvas'), [createPrimitive('box')]).render();`,
  ),
  await measure(
    'orbyt Flare + Bake app (incl. three, path tracer)',
    `import { Flare, Bake, createPrimitive } from 'orbyt'; const p=[createPrimitive('box')]; new Flare(document.querySelector('canvas'), p).render(); new Bake(document.createElement('canvas'), p).render();`,
  ),
  await measure(
    'plain three.js lit-box (WebGLRenderer, standard material, 1 light)',
    `import * as T from 'three';
     const r = new T.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true });
     const s = new T.Scene(); const c = new T.PerspectiveCamera(45, 1, 0.1, 100); c.position.set(2, 2, 3); c.lookAt(0, 0, 0);
     s.add(new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ color: 0x2dd4bf })));
     const l = new T.DirectionalLight(0xffffff, 2); l.position.set(3, 5, 2); s.add(l, new T.AmbientLight(0xffffff, 0.3));
     r.render(s, c);`,
  ),
];
rmSync(tmp, { recursive: true, force: true });
for (const r of rows) console.log(`${r.name.padEnd(70)} ${kb(r.min).padStart(10)} min  ${kb(r.gzip).padStart(9)} gzip`);
