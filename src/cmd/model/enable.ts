/** `coder model enable`: turn a disabled model name back on. */
import { toggle } from './disable';

export const commandModelEnable = toggle(false, {
  usage: 'coder model enable <name> [--workspace]',
  summary: 'Re-enable a disabled model.',
  flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
});
