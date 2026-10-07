/** `coder upgrade refresh`: checks for a newer version in the background. */
import { readVersion } from '../../core/runtime';
import { refreshUpdateCache } from '../../core/update-check';
import { command } from '../../cli';

export const commandRefreshUpdate = command({
  name: 'upgrade refresh',
  options: {},
  run: () => refreshUpdateCache(readVersion()),
});
