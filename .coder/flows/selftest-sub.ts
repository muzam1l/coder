// Value-form flow: top-level await, `args` via import, result via export default.
import { task, gate, log, args } from '@wular/coder/flow';

log(`sub-flow invoked with ${JSON.stringify(args)}`);

// A couple of real steps so nesting shows in stream/result trees.
const echo = await task('Reply with exactly the word "nested", nothing else.', {
  model: 'spark',
  permissions: 'read-only',
  name: 'Nested echo',
});
const check = await gate(`test -n "${echo.output.trim()}"`);
const closing = await gate('echo sub-ok');

export default { output: echo.output.trim(), verified: check.ok && closing.ok };
