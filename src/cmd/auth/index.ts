/** `coder auth login|logout|status`: sign in with Wular and manage saved server sessions. */
import { group } from '../../cli';

const AUTH_MENU: { usage: string; blurb: string }[] = [
  { usage: 'login', blurb: 'sign in through the browser' },
  { usage: 'logout', blurb: 'sign out and forget the saved session' },
  { usage: 'status', blurb: 'show where you are signed in' },
];

export const commandAuth = group(
  'auth',
  {
    login: async () => (await import('./login')).commandLogin,
    logout: async () => (await import('./logout')).commandLogout,
    status: async () => (await import('./status')).commandStatus,
  },
  {
    menu: AUTH_MENU,
    description: ['Sign in to Coder and manage saved server sessions.'],
    exampleCommand: 'auth login',
  },
);
