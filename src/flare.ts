import {
  ACESFilmicToneMapping,
  Color,
  EquirectangularReflectionMapping,
  HalfFloatType,
  MeshNormalMaterial,
  NoToneMapping,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { PartsInput } from './parts.js';
import { Stage, type StageOptions, type View } from './stage.js';

export interface BloomOptions {
  strength?: number;
  radius?: number;
  /** Linear luminance above which pixels bloom. Default 1 (only HDR highlights, e.g. emissive > 1). */
  threshold?: number;
}

export interface FlareOptions extends StageOptions {
  /** Render through a half-float HDR pipeline (MSAA + bloom + ACES output pass). Default true. */
  hdr?: boolean;
  /** Bloom on HDR highlights. `false` disables it. Only used when `hdr` is true. Default on. */
  bloom?: boolean | BloomOptions;
  /** MSAA sample count. Default 4. 0 disables anti-aliasing. */
  samples?: number;
  /** Device pixel ratio. Default `min(devicePixelRatio, 2)`. */
  pixelRatio?: number;
  /** Tone-mapping exposure. Default 1. */
  exposure?: number;
  /** Keep the drawing buffer so `canvas.toDataURL()` works after the frame. Default false. */
  preserveDrawingBuffer?: boolean;
  /** Use an existing three.js renderer instead of creating one. */
  renderer?: WebGLRenderer;
}

export interface FrameOptions extends View {
  /** Tone-mapping exposure for this frame. */
  exposure?: number;
  /** Animation time in seconds (drives clips passed with parts). */
  time?: number;
  /** `beauty` (default) or `normals` (view-space normals, for visual review). */
  mode?: 'beauty' | 'normals';
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Flare — orbyt's real-time WebGL2 renderer.
 *
 * ```js
 * const flare = new Flare(canvas, parts, { hdr: true, environment: { map } });
 * flare.render({ eye: [42, 28, 60], target: [0, 2, -6] });
 * ```
 */
export class Flare {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  readonly stage: Stage;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private pmrem: PMREMGenerator;
  private envTarget: WebGLRenderTarget | null = null;
  private ownsRenderer: boolean;
  private normalMaterial = new MeshNormalMaterial();
  private lastView: FrameOptions = {};
  private size = new Vector2(1, 1);

  constructor(
    readonly canvas: AnyCanvas,
    parts: PartsInput,
    readonly options: FlareOptions = {},
  ) {
    const samples = options.samples ?? 4;
    const hdr = options.hdr ?? true;
    this.ownsRenderer = !options.renderer;
    this.renderer =
      options.renderer ??
      new WebGLRenderer({
        canvas,
        antialias: !hdr && samples > 0,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      });
    const r = this.renderer;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = options.exposure ?? 1;
    r.shadowMap.enabled = options.shadows !== false;
    r.shadowMap.type = PCFShadowMap;
    r.setPixelRatio(options.pixelRatio ?? Math.min(globalThis.devicePixelRatio || 1, 2));

    this.stage = new Stage(parts, options);
    this.pmrem = new PMREMGenerator(r);
    this.setEnvironment(options.environment?.map ?? null);

    if (hdr) {
      const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples });
      this.composer = new EffectComposer(r, target);
      this.composer.addPass(new RenderPass(this.stage.scene, this.camera));
      if (options.bloom !== false) {
        const b = typeof options.bloom === 'object' ? options.bloom : {};
        this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), b.strength ?? 0.3, b.radius ?? 0.35, b.threshold ?? 1);
        this.composer.addPass(this.bloomPass);
      }
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  /** The three.js scene (for advanced use). */
  get scene() {
    return this.stage.scene;
  }

  /** Swap the environment map (equirect HDR texture) at runtime. `null` restores the studio default. */
  setEnvironment(map: Texture | null): void {
    const env = this.options.environment ?? {};
    const scene = this.stage.scene;
    this.envTarget?.dispose();
    if (map) {
      map.mapping = EquirectangularReflectionMapping;
      this.envTarget = this.pmrem.fromEquirectangular(map);
      if (env.background ?? true) {
        scene.background = map;
        scene.backgroundBlurriness = env.blur ?? 0;
        scene.backgroundIntensity = env.intensity ?? 1;
      }
    } else {
      this.envTarget = this.pmrem.fromScene(new RoomEnvironment(), 0.04);
      scene.background = new Color(this.options.background ?? '#060b10');
    }
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = env.intensity ?? (map ? 1 : 0.6);
    const rot = ((env.rotation ?? 0) * Math.PI) / 180;
    scene.environmentRotation.set(0, rot, 0);
    scene.backgroundRotation.set(0, rot, 0);
  }

  /**
   * Match the drawing buffer to the canvas. With no arguments it uses the canvas' CSS size
   * (or its current pixel size for offscreen canvases).
   */
  resize(width?: number, height?: number): void {
    const c = this.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.floor(width ?? (c.clientWidth || c.width || 1)));
    const h = Math.max(1, Math.floor(height ?? (c.clientHeight || c.height || 1)));
    this.size.set(w, h);
    const updateStyle = typeof HTMLCanvasElement !== 'undefined' && this.canvas instanceof HTMLCanvasElement && !c.clientWidth;
    this.renderer.setSize(w, h, updateStyle);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  /** Render one frame. Any omitted view field keeps its previous value (first frame auto-frames the scene). */
  render(frame: FrameOptions = {}): void {
    const f = (this.lastView = { ...this.lastView, ...frame });
    if (f.time !== undefined) this.stage.setTime(f.time);
    this.stage.applyView(this.camera, f, this.size.x / this.size.y);
    const r = this.renderer;
    r.toneMappingExposure = f.exposure ?? this.options.exposure ?? 1;

    if (f.mode === 'normals') {
      const scene = this.stage.scene;
      const { background, overrideMaterial } = scene;
      const ground = this.stage.ground?.visible;
      const tm = r.toneMapping;
      scene.overrideMaterial = this.normalMaterial;
      scene.background = new Color('#000000');
      if (this.stage.ground) this.stage.ground.visible = false;
      r.toneMapping = NoToneMapping;
      r.setRenderTarget(null);
      r.render(scene, this.camera);
      r.toneMapping = tm;
      scene.overrideMaterial = overrideMaterial;
      scene.background = background;
      if (this.stage.ground) this.stage.ground.visible = !!ground;
      return;
    }
    if (this.composer) this.composer.render();
    else r.render(this.stage.scene, this.camera);
  }

  /** Replace the scene content, keeping renderer, environment and camera. */
  replaceParts(parts: PartsInput): void {
    this.stage.setParts(parts);
  }

  /** Recompute bounds/ground/shadows after you moved parts yourself. */
  refit(): void {
    this.stage.fit();
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.composer?.dispose();
    this.bloomPass?.dispose();
    this.normalMaterial.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
