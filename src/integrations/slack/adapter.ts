/** Slack through Chat SDK: the app's signing secret verifies, Coder's bound installations hold the bot tokens. */
import { SlackAdapter, type SlackAdapterConfig } from '@chat-adapter/slack';
import { type Adapter, type ChatInstance, ConsoleLogger } from 'chat';

import { LocalChatState } from '../../server/store/chat';

import type { AdapterContext } from '../types';
import type { SlackAppCredentials } from './app';

/** Stands in for a workspace's bot token until a Web API call needs it, so a webhook is answered before any token lookup. */
const PENDING = 'coder-pending:';

/** An axios adapter for Slack's Web API client on Coder's `fetch`, so hosts and tests see every call; it mints pending tokens. */
function viaFetch(request: typeof fetch, mint: (teamId: string) => Promise<string>) {
  return async (config: {
    url?: string;
    baseURL?: string;
    method?: string;
    headers: { toJSON(): unknown };
    data?: unknown;
  }) => {
    let body = config.data;
    const headers = config.headers.toJSON() as Record<string, string>;
    const form = typeof body === 'string' ? new URLSearchParams(body) : undefined;
    const pending = form?.get('token');
    if (form && pending?.startsWith(PENDING)) {
      form.set('token', await mint(pending.slice(PENDING.length)));
      body = form.toString();
    }
    const bearer = Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
    if (bearer && headers[bearer]!.startsWith(`Bearer ${PENDING}`))
      headers[bearer] = `Bearer ${await mint(headers[bearer]!.slice(`Bearer ${PENDING}`.length))}`;
    const response = await request(new URL(config.url ?? '', config.baseURL), {
      method: config.method?.toUpperCase() ?? 'POST',
      headers,
      body: body as BodyInit | undefined,
    });
    return {
      data: await response.text(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      config,
      request: {},
    };
  };
}

/** Posts outside a webhook (a reply to an event Chat did not deliver) with the bound workspace's token. */
class BoundSlackAdapter extends SlackAdapter {
  constructor(
    config: SlackAdapterConfig,
    private readonly outbound?: () => Promise<string>,
  ) {
    super(config);
  }

  override async initialize(chat: ChatInstance): Promise<void> {
    const local = new LocalChatState();
    const shared = chat.getState();
    const state = new Proxy(shared, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          const owner =
            typeof args[0] === 'string' &&
            /^slack:(?:user:|user-by-name:|thread-participants:)/.test(args[0])
              ? local
              : target;
          return Reflect.apply(Reflect.get(owner, key), owner, args);
        };
      },
    });
    await super.initialize(
      new Proxy(chat, {
        get: (target, key, receiver) =>
          key === 'getState' ? () => state : Reflect.get(target, key, receiver),
      }),
    );
  }

  protected override markEventDelivered(): void {}

  protected override async isDuplicateEventDelivery(): Promise<boolean> {
    return false;
  }

  protected override getToken(): Promise<string> {
    return this.requestContext.getStore()?.token || !this.outbound
      ? super.getToken()
      : this.outbound();
  }
}

export function slackAdapter(ctx: AdapterContext): Adapter {
  const signingSecret = (ctx.credentials as SlackAppCredentials | undefined)?.signingSecret;
  const installationId = ctx.installationId;
  const minted = new Map<string, Promise<string>>();
  const mint = (teamId: string) => {
    if (!minted.has(teamId)) minted.set(teamId, ctx.token(teamId));
    return minted.get(teamId)!;
  };
  // Built without the factory, and every field set, so no SLACK_* variable verifies a request or receives a token.
  return new BoundSlackAdapter(
    {
      userName: ctx.name,
      apiUrl: 'https://slack.com/api/',
      appToken: '',
      socketForwardingSecret: '',
      clientId: '',
      clientSecret: '',
      encryptionKey: '',
      // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
      ...(signingSecret
        ? {
            signingSecret,
            // A webhook names its workspace.
            installationProvider: {
              getInstallation: async (teamId: string) => ({
                botToken: `${PENDING}${teamId}`,
                ...(ctx.self ? { botUserId: ctx.self } : {}),
              }),
            },
          }
        : {
            webhookVerifier: () => false,
            botToken: () =>
              installationId
                ? ctx.token(installationId)
                : Promise.reject(new Error('No Slack workspace to post for')),
          }),
      webClientOptions: { adapter: viaFetch(ctx.fetch, mint) as never },
      logger: new ConsoleLogger('error'),
    },
    signingSecret && installationId ? () => mint(installationId) : undefined,
  );
}
