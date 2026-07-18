import { defineConfig } from 'tsup';

/**
 * Client SDK build (spec §Packaging, T-08.49): ESM + CJS entries, a browser
 * global bundle (script-tag / Phaser embed), and TypeScript declarations. Zero
 * runtime dependencies — an embeddable SDK earns its keep by what it does NOT
 * add to a game build.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2020',
    // Zero runtime deps → nothing to externalize; fail the build if any slips in.
    noExternal: [/.*/],
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
  },
  {
    // Browser global bundle for the script-tag / Phaser embed path.
    // tsup appends `.global` for the iife format → dist/index.global.js.
    entry: { index: 'src/index.ts' },
    format: ['iife'],
    globalName: 'AnalyticsSDK',
    dts: false,
    sourcemap: true,
    minify: true,
    target: 'es2020',
    noExternal: [/.*/],
  },
]);
