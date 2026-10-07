import type { Integration } from '../types';
import { teamsApp, teamsToken } from './app';

const TEAMS_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none"><path d="M 22 20 H 34 C 37.31 20 40 22.69 40 26 V 36 C 40 39.31 37.31 42 34 42 C 30.69 42 28 39.31 28 36 V 26 C 28 22.69 25.31 20 22 20 Z" fill="url(#teams-mark-15)"/><path d="M 8 24 C 8 20.69 10.69 18 14 18 H 22 C 25.31 18 28 20.69 28 24 V 36 C 28 39.31 30.69 42 34 42 L 18 42 C 12.48 42 8 37.52 8 32 V 24 Z" fill="url(#teams-mark-20)"/><path d="M 8 24 C 8 20.69 10.69 18 14 18 H 22 C 25.31 18 28 20.69 28 24 V 36 C 28 39.31 30.69 42 34 42 L 18 42 C 12.48 42 8 37.52 8 32 V 24 Z" fill="url(#teams-mark-24)" fill-opacity="0.7"/><path d="M 8 24 C 8 20.69 10.69 18 14 18 H 22 C 25.31 18 28 20.69 28 24 V 36 C 28 39.31 30.69 42 34 42 L 18 42 C 12.48 42 8 37.52 8 32 V 24 Z" fill="url(#teams-mark-27)" fill-opacity="0.7"/><path d="M 33 18 C 35.76 18 38 15.76 38 13 C 38 10.24 35.76 8 33 8 C 30.24 8 28 10.24 28 13 C 28 15.76 30.24 18 33 18 Z" fill="url(#teams-mark-30)"/><path d="M 33 18 C 35.76 18 38 15.76 38 13 C 38 10.24 35.76 8 33 8 C 30.24 8 28 10.24 28 13 C 28 15.76 30.24 18 33 18 Z" fill="url(#teams-mark-33)" fill-opacity="0.46"/><path d="M 33 18 C 35.76 18 38 15.76 38 13 C 38 10.24 35.76 8 33 8 C 30.24 8 28 10.24 28 13 C 28 15.76 30.24 18 33 18 Z" fill="url(#teams-mark-36)" fill-opacity="0.4"/><path d="M 18 16 C 21.31 16 24 13.31 24 10 C 24 6.69 21.31 4 18 4 C 14.69 4 12 6.69 12 10 C 12 13.31 14.69 16 18 16 Z" fill="url(#teams-mark-39)"/><path d="M 18 16 C 21.31 16 24 13.31 24 10 C 24 6.69 21.31 4 18 4 C 14.69 4 12 6.69 12 10 C 12 13.31 14.69 16 18 16 Z" fill="url(#teams-mark-42)" fill-opacity="0.6"/><path d="M 18 16 C 21.31 16 24 13.31 24 10 C 24 6.69 21.31 4 18 4 C 14.69 4 12 6.69 12 10 C 12 13.31 14.69 16 18 16 Z" fill="url(#teams-mark-45)" fill-opacity="0.5"/><rect x="4" y="23" width="16" height="16" rx="3.25" fill="url(#teams-mark-48)"/><rect x="4" y="23" width="16" height="16" rx="3.25" fill="url(#teams-mark-51)" fill-opacity="0.7"/><path d="M 15.48 28.11 H 13.03 V 35.57 H 10.97 V 28.11 H 8.52 V 26.43 H 15.48 V 28.11 Z" fill="white"/><defs><radialGradient id="teams-mark-15" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(39.8 22.17) scale(13.48 33.27)"><stop stop-color="#A98AFF"/><stop offset="0.14" stop-color="#8C75FF"/><stop offset="0.56" stop-color="#5F50E2"/><stop offset="0.9" stop-color="#3C2CB8"/></radialGradient><radialGradient id="teams-mark-20" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(8.81 16.4) rotate(68.15) scale(32.75 33.12)"><stop stop-color="#85C2FF"/><stop offset="0.69" stop-color="#7588FF"/><stop offset="1" stop-color="#6459FE"/></radialGradient><linearGradient id="teams-mark-24" x1="20.59" y1="18" x2="20.59" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0.8" stop-color="#6864F6" stop-opacity="0"/><stop offset="1" stop-color="#5149DE"/></linearGradient><radialGradient id="teams-mark-27" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(27.5 17.2) rotate(113.33) scale(19.22 15.43)"><stop stop-color="#BD96FF"/><stop offset="0.69" stop-color="#BD96FF" stop-opacity="0"/></radialGradient><radialGradient id="teams-mark-30" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(33 11.57) rotate(-90) scale(10 12.62)"><stop offset="0.27" stop-color="#6868F7"/><stop offset="1" stop-color="#3923B1"/></radialGradient><radialGradient id="teams-mark-33" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(28.87 10.54) rotate(40.05) scale(7.15 10.34)"><stop offset="0.27" stop-color="#A1D3FF"/><stop offset="0.81" stop-color="#A1D3FF" stop-opacity="0"/></radialGradient><radialGradient id="teams-mark-36" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(36.98 10.37) rotate(-41.66) scale(8.51 20.88)"><stop stop-color="#E3ACFD"/><stop offset="0.82" stop-color="#9FA2FF" stop-opacity="0"/></radialGradient><radialGradient id="teams-mark-39" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(18 8.29) rotate(-90) scale(12 15.15)"><stop offset="0.27" stop-color="#8282FF"/><stop offset="1" stop-color="#3923B1"/></radialGradient><radialGradient id="teams-mark-42" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(13.04 7.05) rotate(40.05) scale(8.58 12.4)"><stop offset="0.27" stop-color="#A1D3FF"/><stop offset="0.81" stop-color="#A1D3FF" stop-opacity="0"/></radialGradient><radialGradient id="teams-mark-45" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(22.78 6.84) rotate(-41.66) scale(10.22 25.06)"><stop stop-color="#E3ACFD"/><stop offset="0.82" stop-color="#9FA2FF" stop-opacity="0"/></radialGradient><radialGradient id="teams-mark-48" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(4 23) rotate(45) scale(22.63)"><stop offset="0.05" stop-color="#688EFF"/><stop offset="0.95" stop-color="#230F94"/></radialGradient><radialGradient id="teams-mark-51" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(12 32.6) rotate(90) scale(11.2 13.07)"><stop offset="0.57" stop-color="#6965F6" stop-opacity="0"/><stop offset="1" stop-color="#8F8FFF"/></radialGradient></defs></svg>';

export const teams: Integration = {
  id: 'teams',
  brand: { color: '#4B53BC', icon: 'M3 4h18v4h-7v12h-4V8H3z', svg: TEAMS_MARK },
  name: 'Microsoft Teams',
  description: 'Mentions, messages, and reactions in Microsoft Teams',
  installLabel: 'Add to Teams',
  sample:
    'teams:MTk6Z2VuZXJhbEB0aHJlYWQudGFjdjI:aHR0cHM6Ly9zbWJhLnRyYWZmaWNtYW5hZ2VyLm5ldC90ZWFtcy8:channel',
  history: false,
  hint: 'Keep replies short. Use plain paragraphs and code spans, no Markdown headings, and reply in the conversation where you were addressed.',
  events: {
    mention: {
      description: 'Teams mention of the bot, or a direct message to it',
      on: 'mention',
      addressed: true,
    },
    reaction: { description: 'Reaction added', on: 'reaction' },
    message: {
      description: 'Channel or group chat message the bot can read',
      on: 'message',
      noisy: true,
      addressed: true,
    },
  },
  tools: { presets: { observe: [], comment: [], write: [] } },
  get app() {
    return teamsApp;
  },
  auth: {
    token: (_installation, credentials) => teamsToken(credentials),
  },
  target(req, raw) {
    const app = new URL(req.url).searchParams.get('app');
    let tenant: unknown;
    try {
      const activity = JSON.parse(raw) as {
        channelData?: { tenant?: { id?: unknown } };
        conversation?: { tenantId?: unknown };
      };
      tenant = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId;
    } catch {
      return undefined;
    }
    return app && typeof tenant === 'string' ? { app, installation: tenant } : undefined;
  },
  reactionId: reaction => (reaction.raw as { id?: string }).id,
  adapter: async ctx => (await import('./adapter')).teamsAdapter(ctx),
};
