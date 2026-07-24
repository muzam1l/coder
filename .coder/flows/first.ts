import { z } from 'zod';
import { task, gate, pipeline, log } from '@wular/coder/flow';

const failing = await task('Run `bun test` and list the failing test files.', {
  name: 'Find failing tests',
  returns: z.object({ files: z.array(z.string()) }),
});

log(`got data ${JSON.stringify(failing.data)}`);

export default await pipeline(
  failing.data.files,
  file => task(`Fix the failing tests in ${file}.`, { name: file }),
  (r, file) => gate(`bun test ${file}`),
);
