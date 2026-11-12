// Manual smoke test: node scripts/smoke.mjs [gpu|cpu]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const backend = process.argv[2] ?? "gpu"; // node scripts/smoke.mjs [gpu|cpu]
const t = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/cli.js', '--backend', backend, '--memory', '256'], stderr: 'inherit' });
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(t);
const { tools } = await c.listTools();
console.log(tools.length, 'tools:', tools.map((x) => x.name).join(', '));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content.filter((x) => x.type === 'text').map((x) => x.text).join(' | ');
  console.log(`${name} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}: ${txt.slice(0, 300)}`);
  return r;
};
mkdirSync('test/.out', { recursive: true });
await call('create_scene', { name: 'smoke' });
await call('add_primitive', { shape: 'box', size: [2, 1, 1], position: [0, 0.5, 0], material: { color: '#2dd4bf', roughness: 0.3 } });
await call('add_primitive', { shape: 'sphere', radius: 0.6, position: [-1.8, 0.6, 0.4], material: { color: '#e879f9', metalness: 1, roughness: 0.15 } });
await call('add_primitive', { shape: 'torusKnot', radius: 0.45, position: [1.8, 0.9, 0], material: { color: '#818cf8', emissive: '#818cf8', emissiveIntensity: 2 } });
await call('list_parts');
for (const [name, extra] of [['render_frame', {}], ['render_views', {}], ['render_normals', {}], ['bake_frame', { samples: 16, width: 480, height: 360 }]]) {
  const r = await call(name, { width: 800, height: 600, out: `test/.out/${name}.png`, ...extra });
}
await call('describe_scene');
await c.close();
