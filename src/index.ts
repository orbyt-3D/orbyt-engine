export { Flare, type FlareOptions, type FrameOptions, type BloomOptions } from './flare.js';
export { Bake, type BakeOptions, type BakeFrame, type BakeResult } from './bake.js';
export {
  Stage,
  DEFAULT_BACKGROUND,
  type StageOptions,
  type View,
  type EnvironmentOptions,
  type SunOptions,
  type GroundOptions,
} from './stage.js';
export {
  createPrimitive,
  createMaterial,
  applyMaterial,
  primitiveGeometry,
  toParts,
  isPart,
  PRIMITIVE_SHAPES,
  type Part,
  type PartsInput,
  type PrimitiveShape,
  type PrimitiveOptions,
  type MaterialSpec,
  type Vec3,
} from './parts.js';

export const VERSION = '0.9.2';
