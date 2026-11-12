import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import { createPrimitive, createMaterial, toParts, PRIMITIVE_SHAPES } from '../src/parts';
import { Stage } from '../src/stage';

describe('parts', () => {
  it('builds every primitive shape', () => {
    for (const shape of PRIMITIVE_SHAPES) {
      const p = createPrimitive(shape);
      expect(p.object).toBeInstanceOf(Mesh);
      expect((p.object as Mesh).geometry.attributes.position!.count).toBeGreaterThan(0);
    }
  });

  it('applies transform options (rotation in degrees)', () => {
    const p = createPrimitive('box', { size: [2, 4, 6], position: [1, 2, 3], rotation: [0, 90, 0], scale: 2 });
    expect(p.object.position.toArray()).toEqual([1, 2, 3]);
    expect(p.object.rotation.y).toBeCloseTo(Math.PI / 2);
    const size = new Box3().setFromObject(p.object).getSize(new Vector3());
    expect(size.x).toBeCloseTo(12); // depth 6 rotated onto X, scaled x2
  });

  it('uses physical materials only when needed', () => {
    expect(createMaterial({ roughness: 0.1 })).not.toBeInstanceOf(MeshPhysicalMaterial);
    const glass = createMaterial({ transmission: 1, ior: 1.5 }) as MeshPhysicalMaterial;
    expect(glass).toBeInstanceOf(MeshPhysicalMaterial);
    expect(glass.transmission).toBe(1);
    expect(createMaterial({ opacity: 0.5 }).transparent).toBe(true);
    expect(createMaterial()).toBeInstanceOf(MeshStandardMaterial);
  });

  it('normalises Part, Object3D and arrays', () => {
    const g = new Group();
    g.name = 'g';
    expect(toParts(g)).toEqual([{ name: 'g', object: g }]);
    expect(toParts([g, createPrimitive('sphere')]).map((p) => p.name)).toEqual(['g', 'sphere']);
    expect(() => toParts([{} as never])).toThrow(/neither a Part/);
  });
});

describe('Stage', () => {
  it('fits ground and auto-frames the camera around the parts', () => {
    const stage = new Stage([createPrimitive('box', { size: [4, 2, 4], position: [10, 1, 0] })]);
    expect(stage.ground!.position.y).toBeCloseTo(0, 1);
    const cam = new PerspectiveCamera();
    stage.applyView(cam, {}, 16 / 9);
    const toCenter = new Vector3(10, 1, 0).sub(cam.position).normalize();
    const forward = cam.getWorldDirection(new Vector3());
    expect(forward.dot(toCenter)).toBeGreaterThan(0.999);
    expect(cam.near).toBeLessThan(cam.position.distanceTo(new Vector3(10, 1, 0)) - 3);
  });

  it('respects explicit eye/target/fov and optional ground/sun', () => {
    const stage = new Stage([createPrimitive('sphere')], { ground: false, sun: false });
    expect(stage.ground).toBeNull();
    expect(stage.sun).toBeNull();
    const cam = new PerspectiveCamera();
    stage.applyView(cam, { eye: [42, 28, 60], target: [0, 2, -6], fov: 30 }, 1);
    expect(cam.position.toArray()).toEqual([42, 28, 60]);
    expect(cam.fov).toBe(30);
  });
});
