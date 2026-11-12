import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOrbytServer, TOOLS, ROADMAP_TOOLS } from '../src/mcp/server';
import type { RenderHostLike, RenderArgs } from '../src/mcp/host';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

class FakeHost implements RenderHostLike {
  limits = { maxPixels: 1000 * 1000, maxFileBytes: 1 << 20 };
  renders: RenderArgs[] = [];
  async info() {
    return { webgl2: true, vendor: 'fake', renderer: 'fake', maxTextureSize: 4096, backend: 'gpu' as const, browser: 'fake' };
  }
  async render(_doc: unknown, _files: string[], args: RenderArgs) {
    this.renders.push(args);
    return { png: PNG_1x1, ms: 1, samples: args.samples };
  }
  async renderViews() {
    return { png: PNG_1x1 };
  }
  async inspect(doc: { parts: { id: string; position: [number, number, number] }[] }) {
    return {
      parts: doc.parts.map((p) => ({ id: p.id, center: p.position, size: [1, 1, 1] as [number, number, number], min: null, max: null, meshes: 1, triangles: 12, materials: [] })),
      bounds: { min: [-1, 0, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number], center: [0, 0.5, 0] as [number, number, number] },
    };
  }
  async exportGlb() {
    return new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
  }
  async close() {}
}

const host = new FakeHost();
let client: Client;

beforeAll(async () => {
  const { server } = createOrbytServer({ host });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});
afterAll(() => client.close());

const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string }[] }>;
const textOf = (r: Awaited<ReturnType<typeof call>>) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('orbyt MCP server', () => {
  it('lists exactly the implemented tools, each with a description and schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(TOOLS.length + ROADMAP_TOOLS.length).toBe(19);
  });

  it('edits the scene through tools', async () => {
    await call('create_scene', { name: 'hall' });
    expect(textOf(await call('add_primitive', { shape: 'box', size: [2, 1, 1], material: { color: '#2dd4bf' } }))).toMatch(/Added box "box"/);
    await call('add_primitive', { shape: 'sphere', name: 'ball', position: [3, 1, 0] });
    await call('set_transform', { id: 'ball', translate: [0, 1, 0] });
    await call('set_material', { id: 'box', material: { metalness: 1 } });
    await call('add_light', { kind: 'spot', position: [0, 5, 0], intensity: 50 });
    const list = textOf(await call('list_parts'));
    expect(list).toContain('ball (sphere) at [3, 2, 0]');
    expect(list).toContain('light spot-light (spot)');
    const desc = JSON.parse(textOf(await call('describe_scene')));
    expect(desc.scene.parts[0].material).toEqual({ color: '#2dd4bf', metalness: 1 });
    expect(desc.measured.parts).toHaveLength(2);
    expect(desc.gpu.renderer).toBe('fake');
  });

  it('explodes parts using measured centres', async () => {
    const r = textOf(await call('explode_parts', { factor: 1 }));
    expect(r).toMatch(/Exploded 2 part/);
    expect(textOf(await call('list_parts'))).toContain('ball (sphere) at [6, 3.50, 0]');
  });

  it('returns images from the render tools and downsizes to the memory budget', async () => {
    const r = await call('render_frame', { width: 2000, height: 2000 });
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(textOf(r)).toMatch(/Flare 1000×1000 .*downscaled from 2000×2000/);
    const bake = await call('bake_frame', { samples: 8, width: 64, height: 64 });
    expect(host.renders.at(-1)).toMatchObject({ engine: 'bake', samples: 8 });
    expect(textOf(bake)).toMatch(/8\/8 samples/);
    expect((await call('render_views')).content[0]!.type).toBe('image');
    await call('render_normals', { width: 64, height: 64 });
    expect(host.renders.at(-1)!.mode).toBe('normals');
  });

  it('reports bad input as a tool error instead of crashing', async () => {
    const r = await call('remove_part', { id: 'ghost' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No part "ghost"/);
    const m = await call('load_model', { path: 'does/not/exist.glb' });
    expect(m.isError).toBe(true);
  });
});
