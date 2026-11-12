import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // library: ESM + .d.ts, three & friends stay external
    entry: {
      index: 'src/index.ts',
      'addons/gltf': 'src/addons/gltf.ts',
      'addons/hdri': 'src/addons/hdri.ts',
      'mcp/index': 'src/mcp/index.ts',
    },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: true,
    treeshake: true,
  },
  {
    entry: { 'mcp/cli': 'src/mcp/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
  },
  {
    // headless render runtime: everything (three, pathtracer) bundled for the browser page
    entry: { 'runtime/orbyt-runtime': 'src/runtime/page.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    minify: true,
    noExternal: [/.*/],
    // the page is served from https://orbyt.render/ — give import.meta.url a real base for libs that need one
    define: { 'import.meta.url': '"https://orbyt.render/runtime/orbyt-runtime.js"' },
    outExtension: () => ({ js: '.js' }),
  },
]);
