/** `coder upgrade refresh`: checks for a newer version in the background. */
import { readVersion } from '../../core/runtime';
import { refreshUpdateCache } from '../../core/update-check';
import { command } from '../../cli';

export const commandRefreshUpdate = command({
  name: 'refresh',
  description: 'refresh the cached latest version, detached',
  access: 'write',
  globalFlags: { json: false, cwd: false },
  mcp: false,
  run: () => refreshUpdateCache(readVersion()),
});
