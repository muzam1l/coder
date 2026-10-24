/** Block Kit for Slack: the app's Home tab, direct messages laid out as pages, and messages with buttons. */
import * as z from 'zod/mini';

import type {
  AdapterContext,
  Click,
  LinkButton,
  MessageDraft,
  MessagePlace,
  Page,
} from '../types';
import { slackApi } from './app';
import { ASK_ACTION, ASK_VIEW, CLICK_ACTION, LINK_ACTION } from './events';

const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });
const plain = (text: string) => ({ type: 'plain_text', text });
/** Slack refuses a section text over 3,000 characters. */
const section = (text: string) => ({
  type: 'section',
  text: mrkdwn(text.length > 3000 ? `${text.slice(0, 2999)}…` : text),
});

/** Slack's own escaping for text inside mrkdwn. */
const escaped = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A button that opens `url`; Slack still posts the click, which the host only answers. */
const linkButton = ({ id, url, label, primary }: LinkButton) => ({
  type: 'button',
  action_id: `${LINK_ACTION}${id}`,
  text: { type: 'plain_text', text: label },
  url,
  ...(primary ? { style: 'primary' } : {}),
});

/** A bold title over its text. */
const titled = (title: string, text?: string) =>
  section([`*${escaped(title)}*`, text && escaped(text)].filter(Boolean).join('\n'));

/** A page's blocks; the Home tab sets its buttons apart with a divider. */
function pageBlocks({ title, text, sections, links }: Page, divider?: boolean) {
  return [
    titled(title, text),
    ...sections.map(entry => ({
      ...titled(entry.title, entry.text),
      ...(entry.link ? { accessory: linkButton(entry.link) } : {}),
    })),
    ...(divider ? [{ type: 'divider' }] : []),
    { type: 'actions', elements: links.map(linkButton) },
  ];
}

/** Publishes the Home tab for the user who opened it. */
export async function publishHome(ctx: AdapterContext, user: string): Promise<void> {
  const page = await ctx.home?.(user);
  if (!page || !ctx.installationId) return;
  await slackApi(
    'views.publish',
    { user_id: user, view: { type: 'home', blocks: pageBlocks(page, true) } },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}

/** A direct message to `user`, laid out as a page. */
export async function directMessage(ctx: AdapterContext, user: string, page: Page): Promise<void> {
  if (!ctx.installationId) return;
  await slackApi(
    'chat.postMessage',
    {
      channel: user,
      text: page.title,
      blocks: pageBlocks(page),
      unfurl_links: false,
      unfurl_media: false,
    },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}

/** A Chat SDK Slack thread id as `chat.postMessage` names it; a whole DM has no thread. */
function conversation(threadId: string): { channel: string; thread_ts?: string } {
  const [, channel = '', ts = ''] = /^slack:([^:]+):?(.*)$/.exec(threadId) ?? [];

  return { channel, ...(ts ? { thread_ts: ts } : {}) };
}

/** Markdown as mrkdwn: bold, links and code keep their meaning, everything else is escaped text. */
function mrkdwnOf(markdown: string): string {
  return escaped(markdown)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>');
}

/** Slack refuses a card's body or subtext over 200 characters. */
const cut = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** The message's text or card, its collapsed section as a plan or a block Slack folds under "see more", its buttons, then its hint. */
function messageBlocks({ markdown, card, collapsed, buttons = [], hint, link }: MessageDraft) {
  const elements = [
    ...buttons.map((button, index) => ({
      type: 'button',
      action_id: `${button.ask ? ASK_ACTION : CLICK_ACTION}${index}`,
      text: { type: 'plain_text', text: button.label },
      // An asking button carries what its modal shows, since the click payload holds only the value.
      value: button.ask
        ? JSON.stringify({ value: button.value, label: button.label, ask: button.ask })
        : button.value,
      ...(button.style ? { style: button.style } : {}),
      ...(button.confirm
        ? {
            confirm: {
              title: { type: 'plain_text', text: `${button.label}?` },
              text: { type: 'plain_text', text: button.confirm.slice(0, 300) },
              confirm: { type: 'plain_text', text: button.label },
              deny: { type: 'plain_text', text: 'Cancel' },
            },
          }
        : {}),
    })),
    ...(link ? [linkButton({ id: 'open', ...link })] : []),
  ];
  // A plan holds up to 50 tasks, one per entry; a longer list folds as text.
  const tasks = collapsed?.items && collapsed.items.length <= 50 ? collapsed.items : undefined;
  const status = card?.outcome
    ? { success: 'complete', failure: 'error' }[card.outcome]
    : 'pending';

  return [
    card
      ? {
          type: 'card',
          title: plain(card.title),
          body: plain(cut(card.body)),
          ...(card.status ? { subtext: mrkdwn(cut(mrkdwnOf(card.status))) } : {}),
          ...(elements.length ? { actions: elements } : {}),
        }
      : section(mrkdwnOf(markdown)),
    ...(collapsed
      ? [
          tasks
            ? {
                type: 'plan',
                // Slack wants a fresh `block_id` on every update (plan block reference).
                block_id: `plan-${crypto.randomUUID()}`,
                title: collapsed.summary,
                tasks: tasks.map((task, index) => ({
                  task_id: `task-${index + 1}`,
                  title: task,
                  status,
                })),
              }
            : // `expand: false` lets Slack fold long text under "see more" (section block reference).
              {
                ...section(mrkdwnOf(`**${collapsed.summary}**\n${collapsed.markdown}`)),
                expand: false,
              },
        ]
      : []),
    ...(elements.length && !card ? [{ type: 'actions', elements }] : []),
    ...(hint ? [{ type: 'context', elements: [mrkdwn(mrkdwnOf(hint))] }] : []),
  ];
}

const askedButton = z.object({
  value: z.string(),
  label: z.string(),
  ask: z.object({ label: z.string(), placeholder: z.optional(z.string()) }),
});

/** Opens an asking button's modal for whoever clicked it; its submission comes back as the click. */
export async function openAsk(
  ctx: AdapterContext,
  trigger: string,
  at: Pick<Click, 'thread' | 'message'>,
  value: string,
): Promise<void> {
  const button = askedButton.parse(JSON.parse(value));
  if (!ctx.installationId) return;
  await slackApi(
    'views.open',
    {
      trigger_id: trigger,
      view: {
        type: 'modal',
        callback_id: ASK_VIEW,
        title: plain(button.label.slice(0, 24)),
        submit: plain(button.label.slice(0, 24)),
        close: plain('Cancel'),
        private_metadata: JSON.stringify({ ...at, value: button.value }),
        blocks: [
          {
            type: 'input',
            block_id: ASK_VIEW,
            optional: true,
            label: plain(button.ask.label),
            element: {
              type: 'plain_text_input',
              action_id: ASK_VIEW,
              multiline: true,
              focus_on_load: true,
              ...(button.ask.placeholder ? { placeholder: plain(button.ask.placeholder) } : {}),
            },
          },
        ],
      },
    },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}

/** Posts in the thread; returns the message `ts`. */
export async function postMessage(
  { ctx, thread }: MessagePlace,
  draft: MessageDraft,
): Promise<string> {
  const sent = await slackApi<{ ts: string }>(
    'chat.postMessage',
    {
      ...conversation(thread.id),
      text: draft.markdown,
      blocks: messageBlocks(draft),
      unfurl_links: false,
      unfurl_media: false,
    },
    await ctx.token(ctx.installationId!),
    ctx.fetch,
  );

  return sent.ts;
}

/** Replaces a posted message's text and buttons. */
export async function editMessage(
  { ctx, thread }: MessagePlace,
  ts: string,
  draft: MessageDraft,
): Promise<void> {
  await slackApi(
    'chat.update',
    {
      channel: conversation(thread.id).channel,
      ts,
      text: draft.markdown,
      blocks: messageBlocks(draft),
    },
    await ctx.token(ctx.installationId!),
    ctx.fetch,
  );
}
