/** `coder server app <create>`: the built-in agent's public apps. */
import { group } from '../../../cli';

const SERVER_APP_MENU: { usage: string; blurb: string }[] = [
  { usage: 'create <integration>', blurb: "create the built-in agent's public app" },
];

export const commandServerApp = group(
  'server app',
  { create: async () => (await import('./create')).commandServerAppCreate },
  {
    menu: SERVER_APP_MENU,
    description: [
      "The built-in agent's apps, one per platform, shared by every workspace on this server.",
    ],
    exampleCommand: 'server app create',
  },
);
