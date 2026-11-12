// Generates the example assets:
//   examples/assets/dusk.hdr         — procedural dusk sky (Radiance RGBE, flat scanlines)
//   examples/assets/server-hall.glb  — a server hall built with the orbyt-mcp tools, then export_glb
// Usage: npm run build && npm run assets
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'examples', 'assets');
mkdirSync(out, { recursive: true });

// ---------- dusk.hdr ----------
function rgbe(r, g, b) {
  const m = Math.max(r, g, b);
  if (m < 1e-32) return [0, 0, 0, 0];
  const e = Math.ceil(Math.log2(m));
  const k = 256 / 2 ** e;
  return [Math.min(255, Math.floor(r * k)), Math.min(255, Math.floor(g * k)), Math.min(255, Math.floor(b * k)), e + 128];
}
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function sky(dirY, az) {
  // dirY: -1..1 elevation sine; az: azimuth radians
  const zenith = [0.05, 0.08, 0.22];
  const horizon = [1.1, 0.55, 0.42];
  const ground = [0.03, 0.03, 0.04];
  let c;
  if (dirY >= 0) c = lerp(horizon, zenith, Math.pow(dirY, 0.45));
  else c = lerp(horizon.map((v) => v * 0.25), ground, Math.min(1, -dirY * 6));
  // low sun towards +X, slightly south
  const sunAz = 0.35, sunEl = 0.06;
  const d = Math.acos(Math.min(1, Math.cos(az - sunAz) * Math.cos(Math.asin(dirY)) * Math.cos(sunEl) + dirY * Math.sin(sunEl)));
  const glow = Math.exp(-d * 6) * 3 + (d < 0.03 ? 60 : 0);
  return [c[0] + glow * 1.0, c[1] + glow * 0.62, c[2] + glow * 0.38];
}
{
  const W = 512, H = 256;
  const header = Buffer.from(`#?RADIANCE\n# orbyt procedural dusk\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`, 'ascii');
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI; // +90° at top
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W) * Math.PI * 2 - Math.PI;
      const [r, g, b] = sky(Math.sin(el), az);
      px.set(rgbe(r, g, b), (y * W + x) * 4);
    }
  }
  writeFileSync(join(out, 'dusk.hdr'), Buffer.concat([header, px]));
  console.log('wrote examples/assets/dusk.hdr');
}

// ---------- server-hall.glb via orbyt-mcp ----------
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/mcp/cli.js'), '--backend', 'gpu'], cwd: root, stderr: 'inherit' });
const client = new Client({ name: 'make-assets', version: '0' });
await client.connect(transport);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};
await call('create_scene', { name: 'server-hall' });
await call('add_primitive', { shape: 'box', name: 'floor', size: [56, 0.4, 44], position: [0, -0.2, -6], material: { color: '#1b2329', roughness: 0.6, metalness: 0.1 } });
const rack = { color: '#141a20', metalness: 0.7, roughness: 0.38 };
const rows = [-20, -14, -4, 2, 12];
let n = 0;
for (const [ri, z] of rows.entries()) {
  for (let i = 0; i < 9; i++) {
    const x = -19 + i * 4.6;
    await call('add_primitive', { shape: 'box', name: `rack-${ri}-${i}`, size: [4.2, 4.4, 2.2], position: [x, 2.2, z], material: rack });
    const led = (i + ri) % 3 === 0 ? '#e879f9' : '#2dd4bf';
    const face = ri % 2 === 0 ? 1.12 : -1.12;
    for (const yy of [1.2, 2.4, 3.6]) {
      await call('add_primitive', {
        shape: 'box', name: `led-${n++}`, size: [3.4, 0.08, 0.04], position: [x, yy, z + face],
        material: { color: led, emissive: led, emissiveIntensity: 3 },
      });
    }
  }
}
for (const [i, x] of [-16, -4, 8, 20].entries()) {
  await call('add_primitive', { shape: 'cylinder', name: `chiller-${i}`, radius: 2.2, height: 5, position: [x, 2.5, -27], material: { color: '#c8d2d8', metalness: 0.85, roughness: 0.3 } });
  await call('add_primitive', { shape: 'torus', name: `chiller-ring-${i}`, radius: 2.3, position: [x, 4.2, -27], rotation: [90, 0, 0], material: { color: '#818cf8', emissive: '#818cf8', emissiveIntensity: 2 } });
}
for (const z of [-17, -1, 15]) {
  await call('add_primitive', { shape: 'box', name: `tray-${z}`, size: [46, 0.25, 0.9], position: [1, 6.2, z], material: { color: '#5b6670', metalness: 0.9, roughness: 0.45 } });
}
for (const x of [-26, 26]) for (const z of [-26, -6, 14]) {
  await call('add_primitive', { shape: 'box', name: `column-${x}-${z}`, size: [1.2, 8, 1.2], position: [x, 4, z], material: { color: '#2a333b', roughness: 0.8 } });
}
const r = await call('export_glb', { path: 'examples/assets/server-hall.glb' });
console.log(r.content[0].text);
await call('set_camera', { eye: [42, 28, 60], target: [0, 2, -6] });
await call('set_environment', { hdri: 'examples/assets/dusk.hdr', ground: false });
await call('render_frame', { width: 1280, height: 960, out: 'examples/assets/server-hall.png' });
console.log('wrote examples/assets/server-hall.png');
await client.close();
