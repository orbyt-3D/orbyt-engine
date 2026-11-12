import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SceneStore } from '../doc.js';
import { PRIMITIVE_SHAPES, type PrimitiveShape, type Vec3 } from '../parts.js';
import type { RenderHostLike } from './host.js';

export const VERSION = '0.9.2';

/** Tools this build registers. */
export const TOOLS = [
  'create_scene',
  'add_primitive',
  'load_model',
  'remove_part',
  'list_parts',
  'describe_scene',
  'set_transform',
  'set_material',
  'add_light',
  'set_camera',
  'set_environment',
  'explode_parts',
  'render_frame',
  'render_views',
  'render_normals',
  'bake_frame',
  'export_glb',
  'save_scene',
] as const;

/** Advertised tools that are not implemented yet. */
export const ROADMAP_TOOLS = ['blend_parts'] as const;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const color = z.string().describe('CSS colour, e.g. "#2dd4bf" or "orange"');
const material = z
  .object({
    color: color.optional(),
    metalness: z.number().min(0).max(1).optional(),
    roughness: z.number().min(0).max(1).optional(),
    emissive: color.optional(),
    emissiveIntensity: z.number().min(0).optional().describe('>1 glows and blooms'),
    opacity: z.number().min(0).max(1).optional(),
    transmission: z.number().min(0).max(1).optional().describe('glass: 1 = fully transmissive'),
    ior: z.number().min(1).max(2.5).optional(),
    thickness: z.number().min(0).optional(),
    clearcoat: z.number().min(0).max(1).optional(),
    alphaTest: z.number().min(0).max(1).optional(),
    doubleSided: z.boolean().optional(),
    flatShading: z.boolean().optional(),
    wireframe: z.boolean().optional(),
  })
  .describe('PBR material (metal/rough workflow)');
const size = {
  width: z.number().int().min(16).max(4096).default(1024).describe('image width in px'),
  height: z.number().int().min(16).max(4096).default(768).describe('image height in px'),
};
const viewOverride = {
  eye: vec3.optional().describe('camera position for this render only'),
  target: vec3.optional().describe('look-at point for this render only'),
  fov: z.number().min(5).max(150).optional(),
  out: z.string().optional().describe('also write the PNG to this file path'),
};

export interface ServerOptions {
  host: RenderHostLike;
  /** Base directory for relative paths. Default: process.cwd(). */
  cwd?: string;
  store?: SceneStore;
}

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

function fail(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
}

function wrap<A>(fn: (args: A) => Promise<CallToolResult> | CallToolResult) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

export function createOrbytServer(opts: ServerOptions): { server: McpServer; store: SceneStore } {
  const { host } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const store = opts.store ?? new SceneStore();
  const server = new McpServer(
    { name: 'orbyt', version: VERSION },
    {
      instructions:
        'orbyt keeps one live 3D scene per session. Build it with create_scene / add_primitive / load_model, ' +
        'edit with set_transform / set_material / add_light / set_environment / explode_parts, then look at it with ' +
        'render_frame (real-time Flare), render_views (labelled front/right/top/perspective sheet), render_normals, or ' +
        'bake_frame (path-traced still). Units are metres, Y is up, rotations are degrees. Ids come from list_parts.',
    },
  );
  const abs = (p: string) => resolve(cwd, p);

  const fitSize = (w: number, h: number) => {
    const max = host.limits.maxPixels;
    if (w * h <= max) return { width: w, height: h, note: '' };
    const k = Math.sqrt(max / (w * h));
    const width = Math.max(16, Math.floor(w * k));
    const height = Math.max(16, Math.floor(h * k));
    return { width, height, note: ` (downscaled from ${w}×${h} to fit --memory)` };
  };

  const image = async (png: string, caption: string, out?: string): Promise<CallToolResult> => {
    const data = png.replace(/^data:image\/png;base64,/, '');
    let saved = '';
    if (out) {
      const p = abs(out);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, Buffer.from(data, 'base64'));
      saved = `\nSaved ${p}`;
    }
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: caption + saved }] };
  };

  server.registerTool(
    'create_scene',
    {
      title: 'Create scene',
      description: 'Start a new empty scene (replacing the current one), or load a scene saved with save_scene.',
      inputSchema: {
        name: z.string().optional(),
        from: z.string().optional().describe('path of a .orbyt.json file written by save_scene'),
      },
    },
    wrap(async ({ name, from }: { name?: string; from?: string }) => {
      if (from) {
        store.load(JSON.parse(await readFile(abs(from), 'utf8')));
        if (name) store.doc.name = name;
        return text(`Loaded ${abs(from)}\n${store.summary()}`);
      }
      store.reset(name ?? 'untitled');
      return text(`Created empty scene "${store.doc.name}". Default studio lighting, ground and sun are on.`);
    }),
  );

  server.registerTool(
    'add_primitive',
    {
      title: 'Add primitive',
      description:
        'Add a primitive mesh. Sizes: box uses size [x,y,z]; plane uses size [x,z]; sphere/torus/torusKnot/icosahedron use radius; cylinder/cone/capsule use radius + height. Primitives are centred on their origin.',
      inputSchema: {
        shape: z.enum(PRIMITIVE_SHAPES as unknown as [PrimitiveShape, ...PrimitiveShape[]]),
        name: z.string().optional(),
        size: vec3.optional(),
        radius: z.number().positive().optional(),
        height: z.number().positive().optional(),
        detail: z.number().int().min(0).max(6).optional(),
        position: vec3.optional(),
        rotation: vec3.optional().describe('Euler XYZ degrees'),
        scale: z.union([z.number(), vec3]).optional(),
        material: material.optional(),
      },
    },
    wrap((a: { shape: PrimitiveShape; name?: string; size?: Vec3; radius?: number; height?: number; detail?: number; position?: Vec3; rotation?: Vec3; scale?: number | Vec3; material?: object }) => {
      const p = store.addPart({
        name: a.name,
        source: { kind: 'primitive', shape: a.shape, size: a.size, radius: a.radius, height: a.height, detail: a.detail },
        position: a.position,
        rotation: a.rotation,
        scale: a.scale,
        material: a.material,
      });
      return text(`Added ${a.shape} "${p.id}" at [${p.position.join(', ')}]`);
    }),
  );

  server.registerTool(
    'load_model',
    {
      title: 'Load model',
      description: 'Add a glTF 2.0 model (.glb or .gltf with embedded/sibling resources) from a local file as one part.',
      inputSchema: {
        path: z.string().describe('file path, absolute or relative to the server working directory'),
        name: z.string().optional(),
        position: vec3.optional(),
        rotation: vec3.optional(),
        scale: z.union([z.number(), vec3]).optional(),
      },
    },
    wrap(async (a: { path: string; name?: string; position?: Vec3; rotation?: Vec3; scale?: number | Vec3 }) => {
      const file = abs(a.path);
      if (!existsSync(file)) throw new Error(`File not found: ${file}`);
      if (!['.glb', '.gltf'].includes(extname(file).toLowerCase())) throw new Error('load_model supports .glb and .gltf files');
      const p = store.addPart({ name: a.name, source: { kind: 'model', file }, position: a.position, rotation: a.rotation, scale: a.scale });
      try {
        const info = await host.inspect(store.doc, store.files());
        const me = info.parts.find((x) => x.id === p.id);
        return text(`Loaded "${p.id}" from ${file}` + (me ? `: ${me.meshes} mesh(es), ${me.triangles} triangles, size [${me.size.join(', ')}] m` : ''));
      } catch (e) {
        store.removePart(p.id);
        throw e;
      }
    }),
  );

  server.registerTool(
    'remove_part',
    { title: 'Remove part', description: 'Remove a part or an added light by id.', inputSchema: { id: z.string() } },
    wrap(({ id }: { id: string }) => text(`Removed "${store.removePart(id).id}"`)),
  );

  server.registerTool(
    'list_parts',
    { title: 'List parts', description: 'List part and light ids with their transforms.', inputSchema: {} },
    wrap(() => text(store.summary())),
  );

  server.registerTool(
    'describe_scene',
    {
      title: 'Describe scene',
      description: 'Full scene as JSON plus measured world-space bounds, triangle counts and materials for every part, and the GPU in use.',
      inputSchema: { measure: z.boolean().default(true).describe('measure bounds in the renderer (loads models)') },
    },
    wrap(async ({ measure }: { measure: boolean }) => {
      const out: Record<string, unknown> = { scene: store.doc };
      if (measure && store.doc.parts.length) out.measured = await host.inspect(store.doc, store.files());
      if (measure) out.gpu = await host.info();
      return text(JSON.stringify(out, null, 2));
    }),
  );

  server.registerTool(
    'set_transform',
    {
      title: 'Set transform',
      description: 'Move, rotate, scale or hide a part. `translate` is relative; the others are absolute.',
      inputSchema: {
        id: z.string(),
        position: vec3.optional(),
        translate: vec3.optional(),
        rotation: vec3.optional().describe('Euler XYZ degrees'),
        scale: z.union([z.number(), vec3]).optional(),
        visible: z.boolean().optional(),
      },
    },
    wrap((a: { id: string; position?: Vec3; translate?: Vec3; rotation?: Vec3; scale?: number | Vec3; visible?: boolean }) => {
      const p = store.setTransform(a.id, a);
      return text(`"${p.id}": position [${p.position.join(', ')}], rotation [${p.rotation.join(', ')}], scale [${p.scale.join(', ')}]${p.visible ? '' : ', hidden'}`);
    }),
  );

  server.registerTool(
    'set_material',
    {
      title: 'Set material',
      description: 'Change a part’s PBR material. Merges with the previous override unless replace=true. On models it overrides every mesh.',
      inputSchema: { id: z.string(), material, replace: z.boolean().default(false) },
    },
    wrap((a: { id: string; material: object; replace: boolean }) => {
      const p = store.setMaterial(a.id, a.material, a.replace);
      return text(`"${p.id}" material: ${JSON.stringify(p.material)}`);
    }),
  );

  server.registerTool(
    'add_light',
    {
      title: 'Add light',
      description: 'Add a directional, point or spot light (physical units: point/spot intensity in candela).',
      inputSchema: {
        kind: z.enum(['directional', 'point', 'spot']),
        id: z.string().optional(),
        color: color.optional(),
        intensity: z.number().min(0).optional(),
        position: vec3.optional(),
        target: vec3.optional(),
        distance: z.number().min(0).optional(),
        angle: z.number().min(1).max(89).optional().describe('spot cone half-angle, degrees'),
        castShadow: z.boolean().optional(),
      },
    },
    wrap((a: { kind: 'directional' | 'point' | 'spot' }) => {
      const l = store.addLight(a);
      return text(`Added ${l.kind} light "${l.id}" at [${l.position.join(', ')}], intensity ${l.intensity}`);
    }),
  );

  server.registerTool(
    'set_camera',
    {
      title: 'Set camera',
      description: 'Set the scene camera used by the render tools. auto=true frames the whole scene again.',
      inputSchema: { eye: vec3.optional(), target: vec3.optional(), fov: z.number().min(5).max(150).optional(), auto: z.boolean().optional() },
    },
    wrap((a: { eye?: Vec3; target?: Vec3; fov?: number; auto?: boolean }) => {
      const c = store.setCamera(a);
      return text(`Camera: ${c.eye ? `eye [${c.eye.join(', ')}]` : 'auto-framed'}${c.target ? `, target [${c.target.join(', ')}]` : ''}, fov ${c.fov}`);
    }),
  );

  server.registerTool(
    'set_environment',
    {
      title: 'Set environment',
      description:
        'Lighting and look: HDRI (.hdr/.exr/.jpg equirect file), intensity, background, ground plane, sun, bloom, shadows, exposure.',
      inputSchema: {
        hdri: z.string().optional().describe('path to an equirect map; "" restores the studio environment'),
        intensity: z.number().min(0).optional(),
        background: z.boolean().optional().describe('show the HDRI behind the scene'),
        blur: z.number().min(0).max(1).optional(),
        rotation: z.number().optional().describe('environment rotation in degrees'),
        color: color.optional().describe('solid background colour'),
        ground: z.boolean().optional(),
        sun: z.boolean().optional(),
        sunDirection: vec3.optional(),
        sunIntensity: z.number().min(0).optional(),
        bloom: z.boolean().optional(),
        shadows: z.boolean().optional(),
        exposure: z.number().min(0.01).max(16).optional(),
      },
    },
    wrap((a: { hdri?: string } & Record<string, unknown>) => {
      const { hdri, ...rest } = a;
      let file: string | undefined;
      if (hdri) {
        file = abs(hdri);
        if (!existsSync(file)) throw new Error(`File not found: ${file}`);
      }
      const env = store.setEnvironment({ ...rest, ...(file ? { hdri: file } : {}), clearHdri: hdri === '' });
      return text(`Environment: ${JSON.stringify(env)}`);
    }),
  );

  server.registerTool(
    'explode_parts',
    {
      title: 'Explode parts',
      description: 'Push parts away from the scene centre (exploded view). factor 0.5 moves each part by half its offset from the centre.',
      inputSchema: { factor: z.number().min(-0.95).max(10).default(0.6), ids: z.array(z.string()).optional() },
    },
    wrap(async ({ factor, ids }: { factor: number; ids?: string[] }) => {
      if (!store.doc.parts.length) throw new Error('Scene is empty');
      const info = await host.inspect(store.doc, store.files());
      if (!info.bounds) throw new Error('Scene has no visible geometry');
      const centers = Object.fromEntries(info.parts.map((p) => [p.id, p.center]));
      const moved = store.explode(centers, info.bounds.center as Vec3, factor, ids);
      return text(`Exploded ${moved.length} part(s) by ${factor}:\n` + moved.map((p) => `- ${p.id} → [${p.position.map((n) => n.toFixed(2)).join(', ')}]`).join('\n'));
    }),
  );

  server.registerTool(
    'render_frame',
    {
      title: 'Render frame (Flare)',
      description: 'Render the scene in real time with Flare (WebGL2, PBR, shadows, HDR bloom, ACES) and return a PNG.',
      inputSchema: { ...size, ...viewOverride, time: z.number().optional().describe('animation time in seconds') },
    },
    wrap(async (a: { width: number; height: number; eye?: Vec3; target?: Vec3; fov?: number; out?: string; time?: number }) => {
      const s = fitSize(a.width, a.height);
      const r = await host.render(store.doc, store.files(), { ...a, width: s.width, height: s.height });
      return image(r.png, `Flare ${s.width}×${s.height} in ${r.ms} ms${s.note}`, a.out);
    }),
  );

  server.registerTool(
    'render_views',
    {
      title: 'Render labelled views',
      description: 'One PNG with four labelled views (front, right, top, perspective) for visual review. mode="normals" shows surface normals.',
      inputSchema: { ...size, mode: z.enum(['beauty', 'normals']).default('beauty'), out: viewOverride.out },
    },
    wrap(async (a: { width: number; height: number; mode: 'beauty' | 'normals'; out?: string }) => {
      const s = fitSize(a.width, a.height);
      const r = await host.renderViews(store.doc, store.files(), { width: s.width, height: s.height, mode: a.mode });
      return image(r.png, `Views (${a.mode}) ${s.width}×${s.height}${s.note}`, a.out);
    }),
  );

  server.registerTool(
    'render_normals',
    {
      title: 'Render normals',
      description: 'Render view-space surface normals from the scene camera — useful to spot flipped faces, seams and shading errors.',
      inputSchema: { ...size, ...viewOverride },
    },
    wrap(async (a: { width: number; height: number; eye?: Vec3; target?: Vec3; fov?: number; out?: string }) => {
      const s = fitSize(a.width, a.height);
      const r = await host.render(store.doc, store.files(), { ...a, width: s.width, height: s.height, mode: 'normals' });
      return image(r.png, `Normals ${s.width}×${s.height}${s.note}`, a.out);
    }),
  );

  server.registerTool(
    'bake_frame',
    {
      title: 'Bake frame (path traced)',
      description: 'Path-trace a still with Bake (progressive, physically based). Slower than render_frame; use for final images.',
      inputSchema: {
        ...size,
        ...viewOverride,
        samples: z.number().int().min(1).max(4096).default(64),
        timeoutSeconds: z.number().min(1).max(3600).default(120).describe('stop early and return what has accumulated'),
      },
    },
    wrap(async (a: { width: number; height: number; eye?: Vec3; target?: Vec3; fov?: number; out?: string; samples: number; timeoutSeconds: number }) => {
      const s = fitSize(a.width, a.height);
      const r = await host.render(store.doc, store.files(), {
        ...a,
        width: s.width,
        height: s.height,
        engine: 'bake',
        samples: a.samples,
        timeoutMs: a.timeoutSeconds * 1000,
      });
      return image(r.png, `Bake ${s.width}×${s.height}, ${r.samples}/${a.samples} samples in ${(r.ms / 1000).toFixed(1)} s${s.note}`, a.out);
    }),
  );

  server.registerTool(
    'export_glb',
    {
      title: 'Export GLB',
      description: 'Write the scene (parts, materials, added lights; not the ground/sun) to a binary glTF file.',
      inputSchema: { path: z.string().describe('output .glb path') },
    },
    wrap(async ({ path }: { path: string }) => {
      const p = abs(path);
      const bytes = await host.exportGlb(store.doc, store.files());
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
      return text(`Wrote ${p} (${(bytes.byteLength / 1024).toFixed(1)} KiB)`);
    }),
  );

  server.registerTool(
    'save_scene',
    {
      title: 'Save scene',
      description: 'Save the editable scene description (JSON) so it can be reopened with create_scene { from }.',
      inputSchema: { path: z.string().describe('output path, e.g. hall.orbyt.json') },
    },
    wrap(async ({ path }: { path: string }) => {
      const p = abs(path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(store.doc, null, 2));
      return text(`Saved ${p}`);
    }),
  );

  return { server, store };
}
