/**
 * SceneDoc — the serialisable scene an MCP session edits. Pure data + pure operations,
 * shared by the Node MCP server and the headless browser runtime that renders it.
 */
import type { MaterialSpec, PrimitiveShape, Vec3 } from './parts.js';

export type PartSource =
  | { kind: 'primitive'; shape: PrimitiveShape; radius?: number; height?: number; size?: Vec3; detail?: number }
  | { kind: 'model'; file: string };

export interface PartDoc {
  id: string;
  name: string;
  source: PartSource;
  position: Vec3;
  /** Euler XYZ in degrees. */
  rotation: Vec3;
  scale: Vec3;
  /** Material override. For models it is applied to every mesh. */
  material?: MaterialSpec;
  visible: boolean;
}

export interface LightDoc {
  id: string;
  kind: 'directional' | 'point' | 'spot';
  color: string;
  intensity: number;
  position: Vec3;
  target?: Vec3;
  /** Point/spot range (0 = infinite). */
  distance?: number;
  /** Spot cone angle in degrees. */
  angle?: number;
  castShadow: boolean;
}

export interface CameraDoc {
  eye?: Vec3;
  target?: Vec3;
  fov: number;
}

export interface EnvironmentDoc {
  /** Absolute path of an .hdr/.exr/.jpg equirect map, or undefined for the studio default. */
  hdri?: string;
  intensity: number;
  /** Show the HDRI behind the scene. */
  background: boolean;
  blur: number;
  rotation: number;
  /** Solid background colour when the HDRI is not shown. */
  color: string;
  ground: boolean;
  sun: boolean;
  sunDirection: Vec3;
  sunIntensity: number;
  bloom: boolean;
  shadows: boolean;
  exposure: number;
}

export interface SceneDoc {
  version: 1;
  name: string;
  parts: PartDoc[];
  lights: LightDoc[];
  camera: CameraDoc;
  environment: EnvironmentDoc;
}

export function defaultEnvironment(): EnvironmentDoc {
  return {
    intensity: 1,
    background: true,
    blur: 0,
    rotation: 0,
    color: '#060b10',
    ground: true,
    sun: true,
    sunDirection: [0.55, 1, 0.4],
    sunIntensity: 2.2,
    bloom: true,
    shadows: true,
    exposure: 1,
  };
}

export function emptyScene(name = 'untitled'): SceneDoc {
  return { version: 1, name, parts: [], lights: [], camera: { fov: 45 }, environment: defaultEnvironment() };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'part'
  );
}

/** Pure, synchronous editing operations over a SceneDoc. Throws `Error` with an agent-readable message on bad input. */
export class SceneStore {
  doc: SceneDoc;

  constructor(doc: SceneDoc = emptyScene()) {
    this.doc = doc;
  }

  reset(name?: string): SceneDoc {
    this.doc = emptyScene(name);
    return this.doc;
  }

  load(json: unknown): SceneDoc {
    const d = json as Partial<SceneDoc>;
    if (!d || d.version !== 1 || !Array.isArray(d.parts)) throw new Error('Not an orbyt scene file (expected { version: 1, parts: [...] })');
    this.doc = {
      ...emptyScene(d.name),
      ...d,
      lights: d.lights ?? [],
      camera: { fov: 45, ...d.camera },
      environment: { ...defaultEnvironment(), ...d.environment },
    } as SceneDoc;
    return this.doc;
  }

  uniqueId(base: string): string {
    const taken = new Set([...this.doc.parts.map((p) => p.id), ...this.doc.lights.map((l) => l.id)]);
    const b = slug(base);
    if (!taken.has(b)) return b;
    for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`;
  }

  part(id: string): PartDoc {
    const p = this.doc.parts.find((x) => x.id === id) ?? this.doc.parts.find((x) => x.name === id);
    if (!p) throw new Error(`No part "${id}". Parts: ${this.doc.parts.map((x) => x.id).join(', ') || '(none)'}`);
    return p;
  }

  addPart(input: {
    name?: string;
    source: PartSource;
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3 | number;
    material?: MaterialSpec;
  }): PartDoc {
    const base = input.name ?? (input.source.kind === 'primitive' ? input.source.shape : basename(input.source.file));
    const p: PartDoc = {
      id: this.uniqueId(base),
      name: input.name ?? base,
      source: input.source,
      position: input.position ?? [0, 0, 0],
      rotation: input.rotation ?? [0, 0, 0],
      scale: typeof input.scale === 'number' ? [input.scale, input.scale, input.scale] : input.scale ?? [1, 1, 1],
      material: input.material,
      visible: true,
    };
    this.doc.parts.push(p);
    return p;
  }

  removePart(id: string): PartDoc | LightDoc {
    const li = this.doc.lights.findIndex((l) => l.id === id);
    if (li >= 0) return this.doc.lights.splice(li, 1)[0]!;
    const p = this.part(id);
    this.doc.parts.splice(this.doc.parts.indexOf(p), 1);
    return p;
  }

  setTransform(id: string, t: { position?: Vec3; rotation?: Vec3; scale?: Vec3 | number; translate?: Vec3; visible?: boolean }): PartDoc {
    const p = this.part(id);
    if (t.position) p.position = t.position;
    if (t.translate) p.position = [p.position[0] + t.translate[0], p.position[1] + t.translate[1], p.position[2] + t.translate[2]];
    if (t.rotation) p.rotation = t.rotation;
    if (t.scale !== undefined) p.scale = typeof t.scale === 'number' ? [t.scale, t.scale, t.scale] : t.scale;
    if (t.visible !== undefined) p.visible = t.visible;
    return p;
  }

  setMaterial(id: string, m: MaterialSpec, replace = false): PartDoc {
    const p = this.part(id);
    p.material = replace ? { ...m } : { ...p.material, ...m };
    return p;
  }

  addLight(l: Partial<LightDoc> & { kind: LightDoc['kind'] }): LightDoc {
    const light: LightDoc = {
      id: this.uniqueId(l.id ?? `${l.kind}-light`),
      kind: l.kind,
      color: l.color ?? '#ffffff',
      intensity: l.intensity ?? (l.kind === 'directional' ? 2 : 30),
      position: l.position ?? [3, 5, 3],
      target: l.target,
      distance: l.distance,
      angle: l.angle,
      castShadow: l.castShadow ?? l.kind !== 'point',
    };
    this.doc.lights.push(light);
    return light;
  }

  setCamera(c: Partial<CameraDoc> & { auto?: boolean }): CameraDoc {
    if (c.auto) this.doc.camera = { fov: c.fov ?? this.doc.camera.fov };
    else this.doc.camera = { ...this.doc.camera, ...stripUndefined(c) };
    return this.doc.camera;
  }

  setEnvironment(e: Partial<EnvironmentDoc> & { clearHdri?: boolean }): EnvironmentDoc {
    const { clearHdri, ...rest } = e;
    this.doc.environment = { ...this.doc.environment, ...stripUndefined(rest) };
    if (clearHdri) delete this.doc.environment.hdri;
    return this.doc.environment;
  }

  /** Push parts away from `center` by `factor` × (partCenter − center). */
  explode(centers: Record<string, Vec3>, center: Vec3, factor: number, ids?: string[]): PartDoc[] {
    const moved: PartDoc[] = [];
    for (const p of this.doc.parts) {
      if (ids && !ids.includes(p.id)) continue;
      const c = centers[p.id];
      if (!c) continue;
      p.position = [0, 1, 2].map((i) => p.position[i]! + (c[i]! - center[i]!) * factor) as Vec3;
      moved.push(p);
    }
    return moved;
  }

  /** Files the renderer is allowed to read for this scene. */
  files(): string[] {
    const out = new Set<string>();
    for (const p of this.doc.parts) if (p.source.kind === 'model') out.add(p.source.file);
    if (this.doc.environment.hdri) out.add(this.doc.environment.hdri);
    return [...out];
  }

  summary(): string {
    const d = this.doc;
    const lines = [`scene "${d.name}": ${d.parts.length} part(s), ${d.lights.length} extra light(s)`];
    for (const p of d.parts) {
      const src = p.source.kind === 'primitive' ? p.source.shape : `model ${basename(p.source.file)}`;
      lines.push(`- ${p.id} (${src}) at [${p.position.map(fmt).join(', ')}]${p.visible ? '' : ' hidden'}`);
    }
    for (const l of d.lights) lines.push(`- light ${l.id} (${l.kind}) at [${l.position.map(fmt).join(', ')}]`);
    return lines.join('\n');
  }
}

export function basename(p: string): string {
  const b = p.split(/[\\/]/).pop() ?? p;
  return b.replace(/\.[^.]+$/, '');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
