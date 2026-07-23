import { defineConfig } from 'tsdown';

// One tool for the whole dist: rolldown (oxc) bundles the JS and
// rolldown-plugin-dts bundles the public types into flat entry files
// (vs tsc's one-d.ts-per-module mirror of src/).
export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'lib/broker': 'src/lib/broker.ts',
    sdk: 'src/sdk.ts',
    'flow/index': 'src/flow/index.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  minify: true,
  // zod stays external: it's a real `dependencies` entry (installed alongside),
  // and bundling it would drag its whole type surface into the dts pass.
  // Types only for the two public entrypoints (exports map).
  dts: { emitDtsOnly: false },
  exports: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
