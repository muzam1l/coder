import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'tsdown';

// Every built-in flow (file or folder with index.ts) is its own entry: a plain flow
// file that imports @wular/coder/flow like any user flow (rewritten to dist at run time).
const BUILTIN_FLOWS = 'src/flow/builtin';
const builtinFlowEntries = Object.fromEntries(
  fs.readdirSync(BUILTIN_FLOWS).map(name => {
    const file = path.extname(name) ? name : `${name}/index.ts`;
    return [`flow/builtin/${file.replace(/\.ts$/, '')}`, `${BUILTIN_FLOWS}/${file}`];
  }),
);

// One tool for the whole dist: rolldown (oxc) bundles the JS and
// rolldown-plugin-dts bundles the public types into flat entry files
// (vs tsc's one-d.ts-per-module mirror of src/).
// `bun run build` stages into CODER_DIST and moves it into dist.
const OUT = process.env.CODER_DIST ?? 'dist';
export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'lib/broker': 'src/core/broker/main.ts',
    sdk: 'src/sdk.ts',
    'flow/index': 'src/flow/index.ts',
    ...builtinFlowEntries,
  },
  external: ['@wular/coder/flow', 'drizzle-orm', 'postgres'],
  outDir: OUT,
  // The dashboard build swaps dist/dash in whole; a CLI build leaves it serving.
  clean: [`${OUT}/*`, `!${OUT}/dash`],
  // Built-in agent folders (agent.json + system.md) are read at runtime, so ship them beside the bundle.
  copy: [{ from: 'src/agent/builtin', to: OUT }],
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
