import {
  ACESFilmicToneMapping,
  Color,
  EquirectangularReflectionMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';
import type { PartsInput } from './parts.js';
import { Stage, type StageOptions, type View } from './stage.js';

export interface BakeOptions extends StageOptions {
  /** Device pixel ratio. Default 1 (path tracing is expensive). */
  pixelRatio?: number;
  /** Maximum light bounces. Default 6. */
  bounces?: number;
  /** Tone-mapping exposure. Default 1. */
  exposure?: number;
  /** Use an existing renderer (must have `preserveDrawingBuffer: true` to read pixels back). */
  renderer?: WebGLRenderer;
}

export interface BakeFrame extends View {
  /** Samples per pixel to accumulate. Default 64. */
  samples?: number;
  exposure?: number;
  time?: number;
  /** Called after every completed sample with `(samplesDone, samplesTotal)`. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** Give up after this many milliseconds and resolve with what has accumulated. Default: no limit. */
  timeoutMs?: number;
}

export interface BakeResult {
  /** Samples actually accumulated. */
  samples: number;
  /** Wall-clock time in milliseconds. */
  ms: number;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  toDataURL(type?: string, quality?: number): string;
  toBlob(type?: string, quality?: number): Promise<Blob>;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Bake — progressive path-traced stills (built on three-gpu-pathtracer).
 *
 * ```js
 * const bake = new Bake(canvas, parts, { environment: { map } });
 * const image = await bake.render({ eye: [6, 4, 8], target: [0, 1, 0], samples: 128 });
 * img.src = image.toDataURL();
 * ```
 */
export class Bake {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  readonly stage: Stage;
  readonly pathTracer: WebGLPathTracer;
  private ownsRenderer: boolean;
  private sceneDirty = true;

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    parts: PartsInput,
    readonly options: BakeOptions = {},
  ) {
    this.ownsRenderer = !options.renderer;
    this.renderer = options.renderer ?? new WebGLRenderer({ canvas, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.setPixelRatio(options.pixelRatio ?? 1);
    this.stage = new Stage(parts, { ...options, shadows: false });

    const scene = this.stage.scene;
    const env = options.environment ?? {};
    if (env.map) {
      env.map.mapping = EquirectangularReflectionMapping;
      scene.environment = env.map;
      if (env.background ?? true) scene.background = env.map;
    } else {
      const sky = new GradientEquirectTexture();
      sky.topColor.set('#dfe9f0');
      sky.bottomColor.set('#1a2026');
      sky.update();
      scene.environment = sky;
      scene.background = new Color(options.background ?? '#060b10');
    }
    scene.environmentIntensity = env.intensity ?? 1;

    this.pathTracer = new WebGLPathTracer(this.renderer);
    Object.assign(this.pathTracer, {
      bounces: options.bounces ?? 6,
      renderDelay: 0,
      fadeDuration: 0,
      minSamples: 0,
      dynamicLowRes: false,
      rasterizeScene: false,
    });
    this.pathTracer.tiles.set(1, 1);
    this.resize();
  }

  resize(width?: number, height?: number): void {
    const c = this.canvas as HTMLCanvasElement;
    const w = Math.max(1, Math.floor(width ?? (c.clientWidth || c.width || 1)));
    const h = Math.max(1, Math.floor(height ?? (c.clientHeight || c.height || 1)));
    const updateStyle = typeof HTMLCanvasElement !== 'undefined' && this.canvas instanceof HTMLCanvasElement && !c.clientWidth;
    this.renderer.setSize(w, h, updateStyle);
  }

  replaceParts(parts: PartsInput): void {
    this.stage.setParts(parts);
    this.sceneDirty = true;
  }

  /** Accumulate samples for one view and resolve with the finished image. */
  async render(frame: BakeFrame = {}): Promise<BakeResult> {
    const total = Math.max(1, Math.floor(frame.samples ?? 64));
    const t0 = performance.now();
    if (frame.time !== undefined) {
      this.stage.setTime(frame.time);
      this.sceneDirty = true;
    }
    const size = this.renderer.getSize(new Vector2());
    this.stage.applyView(this.camera, frame, size.x / size.y);
    this.renderer.toneMappingExposure = frame.exposure ?? this.options.exposure ?? 1;

    if (this.sceneDirty) {
      this.pathTracer.setScene(this.stage.scene, this.camera);
      this.sceneDirty = false;
    } else {
      this.pathTracer.updateCamera();
    }
    this.pathTracer.reset();

    let last = -1;
    while (this.pathTracer.samples < total) {
      if (frame.signal?.aborted) throw frame.signal.reason ?? new Error('orbyt: bake aborted');
      if (frame.timeoutMs !== undefined && performance.now() - t0 > frame.timeoutMs) break;
      this.pathTracer.renderSample();
      const done = Math.floor(this.pathTracer.samples);
      if (done !== last) {
        last = done;
        frame.onProgress?.(done, total);
      }
      // yield so async shader compilation and the browser can make progress
      if (this.pathTracer.samples === 0 || done % 4 === 0) await nextTick();
    }

    const canvas = this.canvas;
    return {
      samples: Math.floor(this.pathTracer.samples),
      ms: performance.now() - t0,
      canvas,
      toDataURL: (type = 'image/png', quality?: number) => {
        if ('toDataURL' in canvas) return canvas.toDataURL(type, quality);
        throw new Error('orbyt: toDataURL is not available on OffscreenCanvas; use toBlob()');
      },
      toBlob: (type = 'image/png', quality?: number) =>
        'convertToBlob' in canvas
          ? canvas.convertToBlob({ type, quality })
          : new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality)),
    };
  }

  dispose(): void {
    this.pathTracer.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
