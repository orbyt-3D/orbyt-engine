/**
 * End-to-end: spawns the built `orbyt-mcp` over stdio, renders real frames in headless Chromium.
 * Needs Chrome, Edge or a Playwright Chromium on the machine. Set ORBYT_SKIP_E2E=1 to skip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './mcp-client';
import { TOOLS } from '../src/mcp/server';

type Result = { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };

function pngSize(b64: string) {
  const buf = Buffer.from(b64, 'base64');
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

describe.skipIf(!!process.env.ORBYT_SKIP_E2E)('orbyt-mcp (stdio, headless Chromium)', () => {
  let session: Awaited<ReturnType<typeof connect>>;
  const dir = mkdtempSync(join(tmpdir(), 'orbyt-e2e-'));
  const call = (name: string, args: Record<string, unknown> = {}) => session.client.callTool({ name, arguments: args }) as Promise<Result>;

  beforeAll(async () => {
    session = await connect(['--backend', 'gpu', '--memory', '256']);
  });
  afterAll(async () => {
    await session?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts and lists its tools', async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it('render_frame returns a real PNG of the scene', { timeout: 120_000 }, async () => {
    await call('create_scene', { name: 'e2e' });
    await call('add_primitive', { shape: 'box', position: [0, 0.5, 0], material: { color: '#2dd4bf' } });
    await call('add_primitive', { shape: 'sphere', position: [1.5, 0.5, 0], material: { color: '#e879f9', metalness: 1, roughness: 0.2 } });
    const r = await call('render_frame', { width: 320, height: 240, out: join(dir, 'frame.png') });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const img = r.content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const { width, height, bytes } = pngSize(img.data!);
    expect([width, height]).toEqual([320, 240]);
    expect(bytes).toBeGreaterThan(5_000); // not a blank frame
    expect(readFileSync(join(dir, 'frame.png')).length).toBe(bytes);
  });

  it('render_views and render_normals produce images', { timeout: 60_000 }, async () => {
    const v = await call('render_views', { width: 400, height: 300 });
    expect(pngSize(v.content[0]!.data!).width).toBe(400);
    const n = await call('render_normals', { width: 200, height: 150 });
    expect(pngSize(n.content[0]!.data!).height).toBe(150);
  });

  it('export_glb → load_model round-trips through a real file', { timeout: 60_000 }, async () => {
    const glb = join(dir, 'scene.glb');
    expect((await call('export_glb', { path: glb })).isError).toBeFalsy();
    expect(readFileSync(glb).subarray(0, 4).toString('latin1')).toBe('glTF');
    await call('create_scene', { name: 'reload' });
    const r = await call('load_model', { path: glb, name: 'reloaded' });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/2 mesh\(es\)/);
    const desc = JSON.parse((await call('describe_scene')).content[0]!.text!);
    expect(desc.gpu.webgl2).toBe(true);
  });

  it('save_scene → create_scene { from } restores the scene', async () => {
    const file = join(dir, 'scene.orbyt.json');
    await call('save_scene', { path: file });
    await call('create_scene', { name: 'blank' });
    const r = await call('create_scene', { from: file });
    expect(r.content[0]!.text).toContain('reloaded');
  });
});
