import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EquirectangularReflectionMapping, FloatType, HalfFloatType } from 'three';
import { parseHdri } from '../src/addons/hdri';
import { loadGltf } from '../src/addons/gltf';

const assets = join(__dirname, '..', 'examples', 'assets');
const buf = (f: string) => {
  const b = readFileSync(join(assets, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('addons/hdri', () => {
  it('parses a Radiance .hdr into an equirect float texture', () => {
    const tex = parseHdri(buf('dusk.hdr'));
    expect(tex.image.width).toBe(512);
    expect(tex.image.height).toBe(256);
    expect([HalfFloatType, FloatType]).toContain(tex.type);
    expect(tex.mapping).toBe(EquirectangularReflectionMapping);
  });
});

describe('addons/gltf', () => {
  it('loads a .glb from memory and splits it into named parts', async () => {
    const { parts, animations } = await loadGltf(buf('server-hall.glb'));
    expect(animations).toHaveLength(0);
    expect(parts.length).toBeGreaterThan(100);
    const names = parts.map((p) => p.name);
    expect(names).toContain('floor');
    expect(names.some((n) => n.startsWith('rack-'))).toBe(true);
    const rack = parts.find((p) => p.name.startsWith('rack-'))!;
    expect(rack.object.position.y).toBeCloseTo(2.2); // world transform kept after unwrapping the root
  });

  it('can keep the file whole', async () => {
    const { parts } = await loadGltf(buf('server-hall.glb'), { split: 'whole' });
    expect(parts).toHaveLength(1);
  });
});
