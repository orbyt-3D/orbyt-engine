import type { AnimationClip, Group, Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Part } from '../parts.js';

export interface LoadGltfOptions {
  /**
   * How to split the file into parts:
   * - `top` (default): one part per top-level node of the default scene
   * - `whole`: the entire scene as a single part
   * Files with animations are always loaded `whole` so clips can reach every node.
   */
  split?: 'top' | 'whole';
  /** URL of the Draco decoder folder (enables KHR_draco_mesh_compression). */
  dracoPath?: string;
  /** Base path for external resources when loading from an ArrayBuffer. */
  path?: string;
  onProgress?: (event: ProgressEvent) => void;
}

export interface GltfResult {
  parts: Part[];
  scene: Group;
  animations: AnimationClip[];
  gltf: GLTF;
}

function makeLoader(o: LoadGltfOptions): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (o.dracoPath) loader.setDRACOLoader(new DRACOLoader().setDecoderPath(o.dracoPath));
  return loader;
}

/** Convert a loaded glTF into orbyt parts. */
export function gltfToParts(gltf: GLTF, o: LoadGltfOptions = {}): GltfResult {
  const scene = gltf.scene;
  const animations = gltf.animations ?? [];
  let parts: Part[];
  if (o.split === 'whole' || animations.length > 0 || scene.children.length === 0) {
    parts = [{ name: scene.name || 'model', object: scene, animations }];
  } else {
    // Exporters often wrap everything in a single root node — unwrap it (keeping world transforms).
    scene.updateMatrixWorld(true);
    while (scene.children.length === 1) {
      const only = scene.children[0]!;
      if ((only as { isMesh?: boolean }).isMesh || only.children.length === 0) break;
      for (const child of [...only.children]) scene.attach(child);
      scene.remove(only);
    }
    parts = [...scene.children].map((child: Object3D, i) => ({ name: child.name || `node-${i}`, object: child }));
  }
  for (const p of parts) {
    p.object.traverse((obj: Object3D) => {
      if ((obj as { isMesh?: boolean }).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
  }
  return { parts, scene, animations, gltf };
}

/**
 * Load a .glb / .gltf (URL or ArrayBuffer) and split it into parts for Flare / Bake.
 *
 * ```js
 * const { parts } = await loadGltf('/server-hall.glb');
 * ```
 */
export async function loadGltf(source: string | URL | ArrayBuffer, options: LoadGltfOptions = {}): Promise<GltfResult> {
  const loader = makeLoader(options);
  const gltf: GLTF =
    source instanceof ArrayBuffer
      ? await loader.parseAsync(source, options.path ?? '')
      : await loader.loadAsync(String(source), options.onProgress);
  return gltfToParts(gltf, options);
}

export { GLTFLoader };
