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
const main = defineConfig({
  entry: {
    cli: 'src/cli.ts',
    'lib/broker': 'src/core/broker/main.ts',
    sdk: 'src/sdk.ts',
    schema: 'src/server/store/pg/schema.ts',
    'schema.config': 'src/server/store/pg/push.config.ts',
    'flow/index': 'src/flow/index.ts',
    ...builtinFlowEntries,
  },
  deps: {
    neverBundle: ['@wular/coder/flow', '@vercel/sandbox'],
    alwaysBundle: [/^(?:drizzle-orm|postgres|zod)(?:\/|$)/],
    dts: {
      neverBundle: [/^(?:zod|postgres)(?:\/|$)/],
      alwaysBundle: [/^drizzle-orm(?:\/|$)/],
    },
  },
  // A built-in flow file keeps its own code, so flow discovery reads its description.
  inputOptions: { preserveEntrySignatures: 'allow-extension' },
  outDir: OUT,
  // The dashboard build swaps dist/dash in whole; a CLI build leaves it serving.
  clean: [`${OUT}/*`, `!${OUT}/dash`],
  // Built-in agent folders (agent.json + system.md) are read at runtime, so ship them beside the bundle.
  copy: [{ from: 'src/agent/builtin', to: OUT }],
  format: 'esm',
  platform: 'node',
  minify: true,
  treeshake: { moduleSideEffects: id => id !== 'postgres' },
  // SDK Zod types stay with its optional peer; runtime code is bundled.
  dts: { emitDtsOnly: false, sideEffects: false },
  exports: false,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});

// Flows' full Zod builds alone: a chunk shared with the CLI would load every Zod locale on each command.
export default defineConfig([
  main,
  { ...main, entry: { zod: 'src/flow/zod.ts' }, copy: undefined },
]);
