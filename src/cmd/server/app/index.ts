/** `coder server app <create>`: the built-in agent's public apps. */
import { group } from '../../../cli';
import { commandServerAppCreate } from './create';

export const commandServerApp = group({
  name: 'app',
  description: "the built-in agent's public apps",
  usage: "The built-in agent's apps, one per platform, shared by every workspace on this server.",
  commands: [commandServerAppCreate],
});
