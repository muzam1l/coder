/** `coder model enable`: turn a disabled model name back on. */
import { toggle } from './disable';

export const commandModelEnable = toggle(false, 're-enable a disabled model');
