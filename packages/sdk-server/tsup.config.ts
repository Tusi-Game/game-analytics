import { defineConfig } from 'tsup';

/**
 * Server SDK build (spec §Packaging, T-08.50): dual ESM + CJS entries + bundled
 * type declarations, Node ≥ 20. Minimal dependency surface (a money-path package
 * is a supply-chain target), no native modules, no global state.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node20',
  platform: 'node',
  noExternal: [/.*/],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
