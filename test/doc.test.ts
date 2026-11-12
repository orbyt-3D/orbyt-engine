import { describe, expect, it } from 'vitest';
import { SceneStore, emptyScene } from '../src/doc';

describe('SceneStore', () => {
  it('adds primitives with unique, readable ids', () => {
    const s = new SceneStore();
    const a = s.addPart({ source: { kind: 'primitive', shape: 'box' } });
    const b = s.addPart({ source: { kind: 'primitive', shape: 'box' } });
    const c = s.addPart({ name: 'Rack #1', source: { kind: 'primitive', shape: 'box' } });
    expect([a.id, b.id, c.id]).toEqual(['box', 'box-2', 'rack-1']);
    expect(a.scale).toEqual([1, 1, 1]);
  });

  it('names models after their file', () => {
    const s = new SceneStore();
    const p = s.addPart({ source: { kind: 'model', file: 'C:\\models\\server-hall.glb' } });
    expect(p.id).toBe('server-hall');
    expect(s.files()).toEqual(['C:\\models\\server-hall.glb']);
  });

  it('transforms: absolute, relative, uniform scale, visibility', () => {
    const s = new SceneStore();
    s.addPart({ source: { kind: 'primitive', shape: 'sphere' }, position: [1, 2, 3] });
    const p = s.setTransform('sphere', { translate: [1, 0, -1], scale: 2, visible: false });
    expect(p.position).toEqual([2, 2, 2]);
    expect(p.scale).toEqual([2, 2, 2]);
    expect(p.visible).toBe(false);
  });

  it('merges or replaces materials', () => {
    const s = new SceneStore();
    s.addPart({ source: { kind: 'primitive', shape: 'box' }, material: { color: '#fff', roughness: 0.2 } });
    expect(s.setMaterial('box', { metalness: 1 }).material).toEqual({ color: '#fff', roughness: 0.2, metalness: 1 });
    expect(s.setMaterial('box', { color: '#000' }, true).material).toEqual({ color: '#000' });
  });

  it('gives helpful errors for unknown ids', () => {
    const s = new SceneStore();
    s.addPart({ source: { kind: 'primitive', shape: 'cone' } });
    expect(() => s.part('nope')).toThrow(/No part "nope". Parts: cone/);
  });

  it('removes parts and lights', () => {
    const s = new SceneStore();
    s.addPart({ source: { kind: 'primitive', shape: 'box' } });
    const l = s.addLight({ kind: 'point' });
    expect(l.id).toBe('point-light');
    s.removePart('point-light');
    s.removePart('box');
    expect(s.doc.parts).toHaveLength(0);
    expect(s.doc.lights).toHaveLength(0);
  });

  it('explodes parts away from the centre', () => {
    const s = new SceneStore();
    s.addPart({ name: 'a', source: { kind: 'primitive', shape: 'box' }, position: [1, 0, 0] });
    s.addPart({ name: 'b', source: { kind: 'primitive', shape: 'box' }, position: [-1, 0, 0] });
    s.explode({ a: [1, 0, 0], b: [-1, 0, 0] }, [0, 0, 0], 0.5);
    expect(s.part('a').position).toEqual([1.5, 0, 0]);
    expect(s.part('b').position).toEqual([-1.5, 0, 0]);
  });

  it('camera auto resets eye/target; environment can clear the HDRI', () => {
    const s = new SceneStore();
    s.setCamera({ eye: [1, 2, 3], target: [0, 0, 0], fov: 30 });
    expect(s.setCamera({ auto: true })).toEqual({ fov: 30 });
    s.setEnvironment({ hdri: '/x.hdr', exposure: 1.5 });
    expect(s.doc.environment.hdri).toBe('/x.hdr');
    s.setEnvironment({ clearHdri: true });
    expect(s.doc.environment.hdri).toBeUndefined();
    expect(s.doc.environment.exposure).toBe(1.5);
  });

  it('round-trips through JSON and rejects foreign files', () => {
    const s = new SceneStore();
    s.addPart({ source: { kind: 'primitive', shape: 'torus' } });
    const copy = new SceneStore().load(JSON.parse(JSON.stringify(s.doc)));
    expect(copy).toEqual(s.doc);
    expect(() => new SceneStore().load({ hello: 1 })).toThrow(/Not an orbyt scene/);
    expect(emptyScene('x').environment.ground).toBe(true);
  });
});
