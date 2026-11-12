import {
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  Fog,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Sphere,
  Texture,
  Vector3,
} from 'three';
import { toParts, type Part, type PartsInput, type Vec3 } from './parts.js';

export interface SunOptions {
  /** Direction the light comes FROM (it is normalised). */
  direction?: Vec3;
  color?: string | number;
  intensity?: number;
}

export interface GroundOptions {
  color?: string | number;
  roughness?: number;
  /** World Y of the ground. Defaults to the bottom of the scene bounds. */
  y?: number;
}

export interface EnvironmentOptions {
  /** Equirectangular HDR texture, e.g. from `loadHdri()`. Without one a neutral studio environment is used. */
  map?: Texture | null;
  /** Image-based lighting strength. Default 1. */
  intensity?: number;
  /** Show the environment map behind the scene. Default: true when `map` is given. */
  background?: boolean;
  /** Background blur 0..1 when the map is shown. Default 0. */
  blur?: number;
  /** Environment rotation around Y, in degrees. */
  rotation?: number;
}

export interface StageOptions {
  /** Add a ground plane under the scene that receives shadows. Default true. */
  ground?: boolean | GroundOptions;
  environment?: EnvironmentOptions;
  /** Solid background colour when the environment is not shown. Default `#060b10`. */
  background?: string | number;
  /** Key light. `false` disables it. */
  sun?: false | SunOptions;
  /** Shadow maps. `true`, `false` or a map size (default 2048). Default true. */
  shadows?: boolean | number;
}

export interface View {
  eye?: Vec3;
  target?: Vec3;
  /** Vertical field of view in degrees. Default 45. */
  fov?: number;
}

export const DEFAULT_BACKGROUND = '#060b10';

/**
 * A three.js scene built from parts plus the defaults orbyt adds (ground, sun).
 * Shared by Flare (raster) and Bake (path tracing).
 */
export class Stage {
  readonly scene = new Scene();
  readonly content = new Group();
  readonly bounds = new Box3();
  readonly sphere = new Sphere();
  sun: DirectionalLight | null = null;
  ground: Mesh | null = null;
  parts: Part[] = [];
  private mixers: AnimationMixer[] = [];
  private readonly shadowSize: number;

  constructor(parts: PartsInput, readonly options: StageOptions = {}) {
    this.content.name = 'orbyt:content';
    this.scene.add(this.content);
    this.scene.background = new Color(options.background ?? DEFAULT_BACKGROUND);
    const shadows = options.shadows ?? true;
    this.shadowSize = shadows === false ? 0 : typeof shadows === 'number' ? shadows : 2048;

    if (options.sun !== false) {
      const s = options.sun ?? {};
      this.sun = new DirectionalLight(new Color(s.color ?? '#fff4e6'), s.intensity ?? 1.8);
      this.sun.name = 'orbyt:sun';
      this.sun.castShadow = this.shadowSize > 0;
      if (this.shadowSize) {
        this.sun.shadow.mapSize.set(this.shadowSize, this.shadowSize);
        this.sun.shadow.bias = -0.0004;
        this.sun.shadow.normalBias = 0.02;
      }
      this.scene.add(this.sun, this.sun.target);
    }
    if (options.ground ?? true) {
      const g = typeof options.ground === 'object' ? options.ground : {};
      this.ground = new Mesh(
        new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new MeshStandardMaterial({ color: new Color(g.color ?? '#10181e'), roughness: g.roughness ?? 0.95, envMapIntensity: 0.25 }),
      );
      this.ground.name = 'orbyt:ground';
      this.ground.receiveShadow = true;
      this.scene.add(this.ground);
      // fade the ground into a solid background instead of a hard horizon line
      if (!options.environment?.map || options.environment.background === false) this.scene.fog = new Fog(this.scene.background as Color, 1, 2);
    }
    this.setParts(parts);
  }

  setParts(input: PartsInput): void {
    this.content.clear();
    this.mixers = [];
    this.parts = toParts(input);
    for (const p of this.parts) {
      this.content.add(p.object);
      if (p.animations?.length) {
        const mixer = new AnimationMixer(p.object);
        for (const clip of p.animations) mixer.clipAction(clip).play();
        this.mixers.push(mixer);
      }
    }
    this.fit();
  }

  /** Advance animations to an absolute time in seconds. */
  setTime(t: number): void {
    for (const m of this.mixers) m.setTime(t);
  }

  /** Recompute bounds and refit ground + sun shadow frustum. */
  fit(): void {
    this.content.updateMatrixWorld(true);
    this.bounds.setFromObject(this.content, true);
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-1, 0, -1), new Vector3(1, 1, 1));
    this.bounds.getBoundingSphere(this.sphere);
    const r = Math.max(this.sphere.radius, 0.01);
    const c = this.sphere.center;

    if (this.ground) {
      const g = typeof this.options.ground === 'object' ? this.options.ground : {};
      this.ground.position.set(c.x, g.y ?? this.bounds.min.y - r * 0.002, c.z);
      this.ground.scale.setScalar(r * 40);
    }
    if (this.sun) {
      const d = new Vector3(...(this.options.sun ? this.options.sun.direction ?? [0.55, 1, 0.4] : [0.55, 1, 0.4])).normalize();
      this.sun.position.copy(c).addScaledVector(d, r * 3);
      this.sun.target.position.copy(c);
      const cam = this.sun.shadow.camera;
      Object.assign(cam, { left: -r * 1.2, right: r * 1.2, top: r * 1.2, bottom: -r * 1.2, near: r * 0.5, far: r * 6 });
      cam.updateProjectionMatrix();
    }
    this.content.traverse((o: Object3D) => {
      if ((o as Mesh).isMesh && this.shadowSize) {
        o.castShadow = o.castShadow || o.userData.orbytNoShadow !== true;
        o.receiveShadow = true;
      }
    });
  }

  /** Point a camera according to a view; frames the whole scene when `eye`/`target` are omitted. */
  applyView(camera: PerspectiveCamera, view: View, aspect: number): void {
    const c = this.sphere.center;
    const r = Math.max(this.sphere.radius, 0.01);
    camera.fov = view.fov ?? 45;
    camera.aspect = aspect;
    const target = view.target ? new Vector3(...view.target) : c.clone();
    let eye: Vector3;
    if (view.eye) eye = new Vector3(...view.eye);
    else {
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
      const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
      eye = target.clone().add(new Vector3(1, 0.62, 1.25).normalize().multiplyScalar(dist));
    }
    camera.position.copy(eye);
    camera.up.set(0, 1, 0);
    if (Math.abs(eye.clone().sub(target).normalize().y) > 0.999) camera.up.set(0, 0, -1);
    camera.lookAt(target);
    const d = eye.distanceTo(c);
    camera.near = Math.max(0.01, d > r ? (d - r) * 0.25 : r * 0.001);
    camera.far = (d + r) * (this.ground ? 40 : 4);
    if (this.scene.fog instanceof Fog) {
      this.scene.fog.near = d + r * 0.5;
      this.scene.fog.far = d + r * 7;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
}
