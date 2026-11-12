import {
  AnimationClip,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  CapsuleGeometry,
  DoubleSide,
} from 'three';

/** A named piece of a scene. Flare and Bake render a list of parts. */
export interface Part {
  name: string;
  object: Object3D;
  /** Optional animation clips (skinning / morphs) driven by `render({ time })`. */
  animations?: AnimationClip[];
}

/** Anything Flare/Bake accept as scene content. */
export type PartsInput = Part | Object3D | (Part | Object3D)[];

export type Vec3 = [number, number, number];

export function isPart(v: unknown): v is Part {
  return !!v && typeof v === 'object' && 'object' in v && (v as Part).object instanceof Object3D;
}

/** Normalise whatever the caller passed into a `Part[]`. */
export function toParts(input: PartsInput | null | undefined): Part[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list.map((item, i) => {
    if (isPart(item)) return item;
    if (item instanceof Object3D) return { name: item.name || `part-${i}`, object: item };
    throw new TypeError(`orbyt: parts[${i}] is neither a Part nor a THREE.Object3D`);
  });
}

export type PrimitiveShape =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'torus'
  | 'torusKnot'
  | 'capsule'
  | 'icosahedron';

export const PRIMITIVE_SHAPES: readonly PrimitiveShape[] = [
  'box',
  'sphere',
  'cylinder',
  'cone',
  'plane',
  'torus',
  'torusKnot',
  'capsule',
  'icosahedron',
];

/** PBR material description shared by the JS API and the MCP tools. */
export interface MaterialSpec {
  color?: string | number;
  metalness?: number;
  roughness?: number;
  emissive?: string | number;
  emissiveIntensity?: number;
  opacity?: number;
  /** 0..1 — >0 switches to a physical (glass-capable) material. */
  transmission?: number;
  ior?: number;
  thickness?: number;
  clearcoat?: number;
  /** Alpha cutout threshold (0 = off). */
  alphaTest?: number;
  doubleSided?: boolean;
  flatShading?: boolean;
  wireframe?: boolean;
}

export interface PrimitiveOptions {
  /** Shape-specific size; see `primitiveGeometry`. */
  size?: Vec3 | number;
  radius?: number;
  height?: number;
  detail?: number;
  material?: MaterialSpec;
  name?: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3 | number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

function vec(v: Vec3 | number | undefined, fallback: Vec3): Vec3 {
  if (v === undefined) return fallback;
  return typeof v === 'number' ? [v, v, v] : v;
}

/** Build a geometry for a primitive shape (unit-ish sizes by default, centred at origin). */
export function primitiveGeometry(shape: PrimitiveShape, o: PrimitiveOptions = {}): BufferGeometry {
  const r = o.radius ?? 0.5;
  const h = o.height ?? 1;
  switch (shape) {
    case 'box': {
      const [x, y, z] = vec(o.size, [1, 1, 1]);
      return new BoxGeometry(x, y, z);
    }
    case 'sphere':
      return new SphereGeometry(r, 48, 32);
    case 'cylinder':
      return new CylinderGeometry(r, r, h, 48);
    case 'cone':
      return new ConeGeometry(r, h, 48);
    case 'plane': {
      const [x, y] = vec(o.size, [1, 1, 1]);
      return new PlaneGeometry(x, y).rotateX(-Math.PI / 2);
    }
    case 'torus':
      return new TorusGeometry(r, r * 0.3, 32, 96);
    case 'torusKnot':
      return new TorusKnotGeometry(r, r * 0.3, 200, 32);
    case 'capsule':
      return new CapsuleGeometry(r, h, 8, 24);
    case 'icosahedron':
      return new IcosahedronGeometry(r, o.detail ?? 0);
    default:
      throw new Error(`orbyt: unknown primitive shape "${shape as string}"`);
  }
}

/** Create a PBR material from a spec (MeshStandard, or MeshPhysical when glass/clearcoat is requested). */
export function createMaterial(spec: MaterialSpec = {}): MeshStandardMaterial {
  const physical = (spec.transmission ?? 0) > 0 || (spec.clearcoat ?? 0) > 0;
  const m = physical ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
  applyMaterial(m, { color: '#c8d2d8', metalness: 0, roughness: 0.55, ...spec });
  return m;
}

/** Apply a (partial) material spec to an existing standard material. */
export function applyMaterial(m: MeshStandardMaterial, spec: MaterialSpec): void {
  if (spec.color !== undefined) m.color = new Color(spec.color);
  if (spec.metalness !== undefined) m.metalness = spec.metalness;
  if (spec.roughness !== undefined) m.roughness = spec.roughness;
  if (spec.emissive !== undefined) m.emissive = new Color(spec.emissive);
  if (spec.emissiveIntensity !== undefined) m.emissiveIntensity = spec.emissiveIntensity;
  if (spec.opacity !== undefined) {
    m.opacity = spec.opacity;
    m.transparent = spec.opacity < 1;
  }
  if (spec.alphaTest !== undefined) m.alphaTest = spec.alphaTest;
  if (spec.doubleSided !== undefined) m.side = spec.doubleSided ? DoubleSide : m.side;
  if (spec.flatShading !== undefined) m.flatShading = spec.flatShading;
  if (spec.wireframe !== undefined) m.wireframe = spec.wireframe;
  if (m instanceof MeshPhysicalMaterial) {
    if (spec.transmission !== undefined) m.transmission = spec.transmission;
    if (spec.ior !== undefined) m.ior = spec.ior;
    if (spec.thickness !== undefined) m.thickness = spec.thickness;
    if (spec.clearcoat !== undefined) m.clearcoat = spec.clearcoat;
  }
  m.needsUpdate = true;
}

/** Create a ready-to-render primitive part. */
export function createPrimitive(shape: PrimitiveShape, o: PrimitiveOptions = {}): Part {
  const mesh = new Mesh(primitiveGeometry(shape, o), createMaterial(o.material));
  mesh.name = o.name ?? shape;
  if (o.position) mesh.position.set(...o.position);
  if (o.rotation) mesh.rotation.set(...(o.rotation.map((d) => (d * Math.PI) / 180) as Vec3));
  if (o.scale !== undefined) mesh.scale.set(...vec(o.scale, [1, 1, 1]));
  mesh.castShadow = o.castShadow ?? true;
  mesh.receiveShadow = o.receiveShadow ?? true;
  return { name: mesh.name, object: mesh };
}
