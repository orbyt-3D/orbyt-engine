import { DataTexture, EquirectangularReflectionMapping, SRGBColorSpace, Texture, TextureLoader, type Loader } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

export interface LoadHdriOptions {
  /** Force the format instead of guessing from the URL extension. */
  format?: 'hdr' | 'exr' | 'ldr';
  onProgress?: (event: ProgressEvent) => void;
}

function guessFormat(url: string): 'hdr' | 'exr' | 'ldr' {
  const clean = url.split(/[?#]/)[0]!.toLowerCase();
  if (clean.endsWith('.exr')) return 'exr';
  if (clean.endsWith('.hdr') || clean.endsWith('.rgbe') || clean.endsWith('.pic')) return 'hdr';
  return 'ldr';
}

function finish<T extends Texture>(tex: T): T {
  tex.mapping = EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

/** Parse an in-memory Radiance .hdr (RGBE) or OpenEXR buffer into an equirect texture. */
export function parseHdri(buffer: ArrayBuffer, format: 'hdr' | 'exr' = 'hdr'): DataTexture {
  const loader = format === 'exr' ? new EXRLoader() : new HDRLoader();
  const tex = loader.createDataTexture(buffer);
  tex.needsUpdate = true;
  return finish(tex);
}

/**
 * Load an equirectangular environment map (.hdr, .exr, or an 8-bit .jpg/.png/.webp)
 * ready to pass as `environment.map`.
 *
 * ```js
 * const map = await loadHdri('/dusk.hdr');
 * new Flare(canvas, parts, { environment: { map } });
 * ```
 */
export async function loadHdri(source: string | URL | ArrayBuffer, options: LoadHdriOptions = {}): Promise<Texture> {
  if (source instanceof ArrayBuffer) return parseHdri(source, options.format === 'exr' ? 'exr' : 'hdr');
  const url = String(source);
  const format = options.format ?? guessFormat(url);
  if (format === 'ldr') {
    const tex = await new TextureLoader().loadAsync(url, options.onProgress);
    tex.colorSpace = SRGBColorSpace;
    return finish(tex);
  }
  const loader: Loader<DataTexture> = format === 'exr' ? (new EXRLoader() as never) : (new HDRLoader() as never);
  return finish(await loader.loadAsync(url, options.onProgress));
}
