/** `coder auth login|logout|status`: sign in with Wular and manage saved server sessions. */
import { group } from '../../cli';
import { commandLogin } from './login';
import { commandLogout } from './logout';
import { commandStatus } from './status';

export const commandAuth = group({
  name: 'auth',
  description: 'sign in to Coder and manage saved server sessions',
  commands: [commandLogin, commandLogout, commandStatus],
});
