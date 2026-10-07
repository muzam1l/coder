import { siLinear } from 'simple-icons';
import type { Integration } from '../types';
import { linearApp, linearToken, linearUserAuth } from './app';

const PROMPT_CONTEXT_LIMIT = 16 * 1024;

const LINEAR_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="#222326" viewBox="0 0 100 100" style="fill:light-dark(#222326,#fff)"><path d="M 1.23 61.52 c -0.22 -0.95 0.91 -1.55 1.6 -0.86 L 39.33 97.18 c 0.69 0.69 0.09 1.82 -0.86 1.6 C 20.05 94.45 5.55 79.95 1.23 61.52 Z M 0 46.89 c -0.02 0.28 0.09 0.56 0.29 0.76 L 52.35 99.71 c 0.2 0.2 0.48 0.31 0.76 0.29 2.37 -0.15 4.69 -0.46 6.96 -0.93 0.76 -0.16 1.03 -1.1 0.48 -1.65 L 2.58 39.45 c -0.55 -0.55 -1.49 -0.29 -1.65 0.48 -0.47 2.27 -0.78 4.59 -0.93 6.96 Z M 4.21 29.71 c -0.17 0.37 -0.08 0.81 0.21 1.1 l 64.78 64.78 c 0.29 0.29 0.73 0.37 1.1 0.21 1.79 -0.8 3.52 -1.69 5.19 -2.68 0.55 -0.33 0.64 -1.09 0.18 -1.54 L 8.44 24.34 c -0.45 -0.45 -1.21 -0.37 -1.54 0.18 -0.99 1.67 -1.89 3.4 -2.68 5.19 Z M 12.66 18.07 c -0.37 -0.37 -0.39 -0.96 -0.04 -1.35 C 21.78 6.46 35.11 0 49.95 0 77.59 0 100 22.41 100 50.05 c 0 14.84 -6.46 28.17 -16.72 37.34 -0.39 0.35 -0.98 0.33 -1.35 -0.04 L 12.66 18.07 Z"/></svg>';

export const linear: Integration = {
  id: 'linear',
  brand: { color: '#222326', icon: siLinear.path, svg: LINEAR_MARK },
  name: 'Linear',
  description: 'Agent sessions on Linear issues: mentions and assignments',
  installLabel: 'Connect Linear',
  sample: 'linear:2f1e6a1c-0000-4000-8000-000000000001:s:5b7d3c2a-0000-4000-8000-000000000002',
  hint: "You are working in a Linear issue's agent session. Keep replies short and about the issue; link pull requests you open.",
  events: {
    mention: {
      description: 'Agent session started or prompted by mentioning or assigning the agent',
      on: 'mention',
      addressed: true,
      steers: true,
    },
  },
  tools: { presets: { observe: [], comment: [], write: [] } },
  get app() {
    return linearApp;
  },
  auth: {
    token: (installation, credentials, _bound, save) =>
      linearToken(installation, credentials, save),
    get user() {
      return linearUserAuth;
    },
  },
  target(req, raw) {
    const app = new URL(req.url).searchParams.get('app');
    let organization: unknown;
    try {
      organization = (JSON.parse(raw) as { organizationId?: unknown }).organizationId;
    } catch {
      return undefined;
    }
    return app && typeof organization === 'string'
      ? { app, installation: organization }
      : undefined;
  },
  adapter: async ctx => (await import('./adapter')).linearAdapter(ctx),
  // Linear marks a session unresponsive without an activity within 10 seconds, so the agent thinks aloud before dispatch.
  event(type, thread, message) {
    void thread.startTyping('Reading the issue').catch(() => {});
    const context = (message.raw as { agentSessionPromptContext?: string })
      .agentSessionPromptContext;
    return {
      type,
      actor: { id: message.author.userId, login: message.author.userName },
      ...(context ? { promptContext: context.slice(0, PROMPT_CONTEXT_LIMIT) } : {}),
    };
  },
};
