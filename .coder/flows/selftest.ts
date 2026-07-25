// Exercises every flow feature with cheap spark tasks; preview with --dry-run.
import { z } from 'zod';
import { task, gate, pipeline, flow, log, args } from '@wular/coder/flow';

const items = (args.items ?? ['alpha', 'beta']) as string[];
log(`selftest over ${items.length} items`);

// task with structured output (`returns` schema -> r.data)
const sea = await task('Reply with three short lowercase words about the sea.', {
  model: 'spark',
  permissions: 'read-only',
  name: 'Sea words',
  returns: z.object({ words: z.array(z.string()).length(3) }),
});
log(`structured: ${sea.data?.words.join(', ') ?? '(dry-run)'}`);

// gates: deterministic shell checkpoints; a failing gate returns, never throws
const okGate = await gate('echo checkpoint');
const badGate = await gate('exit 3');

// pipeline: per-item stages, no barrier; a gate verifies each task's output
const echoed = await pipeline(
  items,
  item =>
    task(`Reply with exactly the word "${item}" reversed, nothing else.`, {
      model: 'spark',
      permissions: 'read-only',
      name: `Reverse ${item}`,
    }),
  async (r, item) => {
    const g = await gate(`test -n "${r.output}"`);
    return { item, output: r.output.trim(), verified: g.ok };
  },
);

// plain parallel batch: just Promise.all
const batch = await Promise.all(items.map(i => gate(`echo batch-${i}`)));

// a failing task throws; catch it to park instead of dying
let parked: string | null = null;
try {
  await task('This dispatch is expected to fail.', { model: 'no-such-model', name: 'Expected fail' });
} catch (error) {
  parked = error instanceof Error ? error.message : String(error);
}

// sub-flow: shares this run's journal, concurrency, and ledger
const sub = await flow('selftest-sub', { n: items.length });

// a step after the sub-flow, so the tree resumes at the top level
const wrapUp = await gate('echo wrap-up');

export default {
  structured: sea.data ?? null,
  gates: { ok: okGate.ok, failing: badGate.ok },
  echoed,
  batch: batch.map(b => b.output),
  parked,
  sub,
  wrapUp: wrapUp.output,
};
