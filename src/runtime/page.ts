/**
 * Headless render runtime. Bundled (with three.js) into dist/runtime/orbyt-runtime.js and loaded
 * by orbyt-mcp into a headless Chromium page. Exposes `window.orbytRuntime`.
 */
import {
  Box3,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  SpotLight,
  Texture,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Flare } from '../flare.js';
import { Bake } from '../bake.js';
import { applyMaterial, createPrimitive, type Part, type Vec3 } from '../parts.js';
import { loadGltf, type GltfResult } from '../addons/gltf.js';
import { loadHdri } from '../addons/hdri.js';
import type { SceneDoc } from '../doc.js';
import type { StageOptions } from '../stage.js';

export const fileUrl = (path: string) => `/files/${encodeURIComponent(path)}`;

const models = new Map<string, Promise<GltfResult>>();
const hdris = new Map<string, Promise<Texture>>();
let renderer: WebGLRenderer | null = null;
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

function getRenderer(): WebGLRenderer {
  if (!renderer) renderer = new WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
  return renderer;
}

function info() {
  const gl = getRenderer().getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}

const rad = (v: Vec3) => v.map((d) => (d * Math.PI) / 180) as Vec3;

async function buildParts(doc: SceneDoc): Promise<Part[]> {
  const parts: Part[] = [];
  for (const p of doc.parts) {
    let object: Object3D;
    let animations: Part['animations'];
    if (p.source.kind === 'primitive') {
      object = createPrimitive(p.source.shape, { ...p.source, material: p.material }).object;
    } else {
      const file = p.source.file;
      if (!models.has(file)) models.set(file, loadGltf(fileUrl(file), { split: 'whole' }));
      const gltf = await models.get(file)!.catch((e) => {
        models.delete(file);
        throw new Error(`Could not load model ${file}: ${e?.message ?? e}`);
      });
      const root = skeletonClone(gltf.scene);
      const group = new Group();
      group.add(root);
      if (p.material) {
        root.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m: Material) => {
            const c = (m as MeshStandardMaterial).isMeshStandardMaterial ? (m.clone() as MeshStandardMaterial) : new MeshStandardMaterial();
            applyMaterial(c, p.material!);
            return c;
          });
          mesh.material = Array.isArray(mesh.material) ? mats : mats[0]!;
        });
      }
      object = group;
      animations = gltf.animations;
    }
    object.name = p.id;
    object.userData.orbytId = p.id;
    object.position.set(...p.position);
    object.rotation.set(...rad(p.rotation));
    object.scale.set(...p.scale);
    object.visible = p.visible;
    parts.push({ name: p.id, object, animations });
  }
  for (const l of doc.lights) {
    let light: DirectionalLight | PointLight | SpotLight;
    if (l.kind === 'directional') light = new DirectionalLight(l.color, l.intensity);
    else if (l.kind === 'point') light = new PointLight(l.color, l.intensity, l.distance ?? 0);
    else light = new SpotLight(l.color, l.intensity, l.distance ?? 0, ((l.angle ?? 30) * Math.PI) / 180, 0.3);
    light.name = l.id;
    light.position.set(...l.position);
    light.castShadow = l.castShadow;
    if (light.castShadow) light.shadow.mapSize.set(1024, 1024);
    if ('target' in light) {
      light.target.position.set(...(l.target ?? [0, 0, 0]));
      const holder = new Group();
      holder.add(light, light.target);
      parts.push({ name: l.id, object: holder });
    } else parts.push({ name: l.id, object: light });
  }
  return parts;
}

async function stageOptions(doc: SceneDoc): Promise<StageOptions> {
  const e = doc.environment;
  let map: Texture | null = null;
  if (e.hdri) {
    if (!hdris.has(e.hdri)) hdris.set(e.hdri, loadHdri(fileUrl(e.hdri), { format: /\.exr$/i.test(e.hdri) ? 'exr' : /\.(hdr|pic|rgbe)$/i.test(e.hdri) ? 'hdr' : 'ldr' }));
    map = await hdris.get(e.hdri)!.catch((err) => {
      hdris.delete(e.hdri!);
      throw new Error(`Could not load HDRI ${e.hdri}: ${err?.message ?? err}`);
    });
  }
  return {
    ground: e.ground,
    background: e.color,
    sun: e.sun ? { direction: e.sunDirection, intensity: e.sunIntensity } : false,
    shadows: e.shadows,
    environment: { map, intensity: e.intensity, background: e.background, blur: e.blur, rotation: e.rotation },
  };
}

export interface RenderRequest {
  width: number;
  height: number;
  mode?: 'beauty' | 'normals';
  engine?: 'flare' | 'bake';
  samples?: number;
  timeoutMs?: number;
  eye?: Vec3;
  target?: Vec3;
  fov?: number;
  time?: number;
}

async function render(doc: SceneDoc, req: RenderRequest) {
  const parts = await buildParts(doc);
  const opts = await stageOptions(doc);
  const view = { eye: req.eye ?? doc.camera.eye, target: req.target ?? doc.camera.target, fov: req.fov ?? doc.camera.fov, time: req.time };
  const r = getRenderer();
  r.setPixelRatio(1);
  if (req.engine === 'bake') {
    const bake = new Bake(canvas, parts, { ...opts, renderer: r, exposure: doc.environment.exposure });
    bake.resize(req.width, req.height);
    const res = await bake.render({ ...view, samples: req.samples ?? 64, timeoutMs: req.timeoutMs });
    const png = canvas.toDataURL('image/png');
    bake.dispose();
    return { png, samples: res.samples, ms: Math.round(res.ms) };
  }
  const t0 = performance.now();
  const flare = new Flare(canvas, parts, { ...opts, renderer: r, pixelRatio: 1, bloom: doc.environment.bloom, exposure: doc.environment.exposure });
  flare.resize(req.width, req.height);
  flare.render({ ...view, mode: req.mode });
  const png = canvas.toDataURL('image/png');
  const cam = flare.camera;
  const camera = { eye: cam.position.toArray(), fov: cam.fov };
  flare.dispose();
  return { png, ms: Math.round(performance.now() - t0), camera };
}

const VIEWS: { label: string; dir: Vec3 }[] = [
  { label: 'FRONT', dir: [0, 0, 1] },
  { label: 'RIGHT', dir: [1, 0, 0] },
  { label: 'TOP', dir: [0, 1, 0] },
  { label: 'PERSPECTIVE', dir: [1, 0.62, 1.25] },
];

/** 2×2 labelled contact sheet: front / right / top / perspective. */
async function renderViews(doc: SceneDoc, req: { width: number; height: number; mode?: 'beauty' | 'normals' }) {
  const parts = await buildParts(doc);
  const opts = await stageOptions(doc);
  const r = getRenderer();
  r.setPixelRatio(1);
  const cw = Math.floor(req.width / 2);
  const ch = Math.floor(req.height / 2);
  const flare = new Flare(canvas, parts, { ...opts, renderer: r, pixelRatio: 1, bloom: doc.environment.bloom, exposure: doc.environment.exposure });
  flare.resize(cw, ch);
  const sheet = document.createElement('canvas');
  sheet.width = cw * 2;
  sheet.height = ch * 2;
  const ctx = sheet.getContext('2d')!;
  const { center, radius } = flare.stage.sphere;
  const fov = 35;
  const dist = (Math.max(radius, 0.01) / Math.sin(((fov * Math.PI) / 180) / 2)) * 1.05;
  VIEWS.forEach((v, i) => {
    const d = new Vector3(...v.dir).normalize().multiplyScalar(dist).add(center);
    flare.render({ eye: d.toArray() as Vec3, target: center.toArray() as Vec3, fov, mode: req.mode });
    const x = (i % 2) * cw;
    const y = Math.floor(i / 2) * ch;
    ctx.drawImage(canvas, x, y, cw, ch);
    ctx.font = '600 13px system-ui, sans-serif';
    const w = ctx.measureText(v.label).width + 16;
    ctx.fillStyle = 'rgba(6,11,16,.72)';
    ctx.fillRect(x + 10, y + 10, w, 24);
    ctx.fillStyle = '#2dd4bf';
    ctx.fillText(v.label, x + 18, y + 27);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath();
  ctx.moveTo(cw, 0);
  ctx.lineTo(cw, ch * 2);
  ctx.moveTo(0, ch);
  ctx.lineTo(cw * 2, ch);
  ctx.stroke();
  flare.dispose();
  return { png: sheet.toDataURL('image/png') };
}

/** Bounds and stats per part (world space). */
async function inspect(doc: SceneDoc) {
  const parts = await buildParts(doc);
  const root = new Group();
  for (const p of parts) root.add(p.object);
  root.updateMatrixWorld(true);
  const all = new Box3();
  const out = parts
    .filter((p) => doc.parts.some((d) => d.id === p.name))
    .map((p) => {
      const box = new Box3().setFromObject(p.object, true);
      let triangles = 0;
      let meshes = 0;
      const materials = new Set<string>();
      p.object.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        meshes++;
        const g = m.geometry;
        triangles += (g.index ? g.index.count : g.attributes.position!.count) / 3;
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat: Material) => materials.add(mat.name || mat.type));
      });
      if (!box.isEmpty() && p.object.visible) all.union(box);
      const c = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
      const s = box.isEmpty() ? new Vector3() : box.getSize(new Vector3());
      return {
        id: p.name,
        center: c.toArray().map(round) as Vec3,
        size: s.toArray().map(round) as Vec3,
        min: box.isEmpty() ? null : (box.min.toArray().map(round) as Vec3),
        max: box.isEmpty() ? null : (box.max.toArray().map(round) as Vec3),
        meshes,
        triangles: Math.round(triangles),
        materials: [...materials].slice(0, 12),
      };
    });
  return {
    parts: out,
    bounds: all.isEmpty()
      ? null
      : { min: all.min.toArray().map(round), max: all.max.toArray().map(round), center: all.getCenter(new Vector3()).toArray().map(round) },
  };
}

async function exportGlb(doc: SceneDoc): Promise<string> {
  const parts = await buildParts(doc);
  const root = new Group();
  root.name = doc.name;
  for (const p of parts) root.add(p.object);
  const buf = (await new GLTFExporter().parseAsync(root, { binary: true, animations: parts.flatMap((p) => p.animations ?? []) })) as ArrayBuffer;
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

(globalThis as unknown as { orbytRuntime: unknown }).orbytRuntime = { info, render, renderViews, inspect, exportGlb, ready: true };
