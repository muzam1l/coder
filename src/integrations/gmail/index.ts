import { siGmail } from 'simple-icons';
import type { GmailAdapter, GmailRawMessage } from '@chat-adapter/gmail';

import type { Integration } from '../types';
import { gmailApp, gmailToken, gmailUserAuth } from './app';

/** The mailbox a Pub/Sub push names, read unverified. */
function mailbox(raw: string): string | undefined {
  try {
    const data = (JSON.parse(raw) as { message?: { data?: string } }).message?.data;
    const address = (
      JSON.parse(Buffer.from(data ?? '', 'base64').toString()) as { emailAddress?: unknown }
    ).emailAddress;
    return typeof address === 'string' ? address.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Google's own topmost authentication result says the sender's domain passed DMARC, so the From address is theirs. */
function authenticated(raw: GmailRawMessage): boolean {
  const result =
    raw.email.headers.find(header => header.key === 'authentication-results')?.value ?? '';
  return /^\s*mx\.google\.com;/.test(result) && /\bdmarc=pass\b/.test(result);
}

/** The four-colour Gmail mark; the dashboard shows it full colour. */
const GMAIL_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 192 192"><path fill="url(#gmail-mark-5)" d="M 146 44 h 38 v 110 c 0 6.63 -5.37 12 -12 12 h -20 a 6 6 0 0 1 -6 -6 z"/><path fill="#fc413d" d="M 46 44 H 8 v 110 c 0 6.63 5.37 12 12 12 h 20 a 6 6 0 0 0 6 -6 z"/><path fill="url(#gmail-mark-12)" d="M 39.23 30.46 c -8.03 -6.75 -20.02 -5.71 -26.77 2.32 -6.75 8.03 -5.71 20.02 2.32 26.77 l 76.08 63.95 a 8 8 0 0 0 10.29 0 l 76.08 -63.95 c 8.03 -6.75 9.07 -18.74 2.32 -26.77 -6.75 -8.03 -18.74 -9.07 -26.77 -2.32 L 96 78.18 z"/><defs><linearGradient id="gmail-mark-5" x1="165" x2="165" y1="44" y2="166" gradientUnits="userSpaceOnUse"><stop stop-color="#60d673"/><stop offset="0.17" stop-color="#42c868"/><stop offset="0.39" stop-color="#0ebc5f"/><stop offset="0.62" stop-color="#00a9bb"/><stop offset="0.86" stop-color="#3c90ff"/><stop offset="1" stop-color="#3186ff"/></linearGradient><linearGradient id="gmail-mark-12" x1="8" x2="184" y1="46.13" y2="46.13" gradientUnits="userSpaceOnUse"><stop offset="0.08" stop-color="#ff63a0"/><stop offset="0.3" stop-color="#fc413d"/><stop offset="0.5" stop-color="#fc413d"/><stop offset="0.65" stop-color="#fc413d"/><stop offset="0.72" stop-color="#fc5c30"/><stop offset="0.86" stop-color="#feb10c"/><stop offset="0.91" stop-color="#fec700"/><stop offset="0.96" stop-color="#ffdb0f"/></linearGradient></defs></svg>';

export const gmail: Integration = {
  id: 'gmail',
  brand: { color: '#FC413D', icon: siGmail.path, svg: GMAIL_MARK },
  name: 'Gmail',
  description: 'Email that arrives under one label of a Gmail mailbox',
  installLabel: 'Connect Gmail',
  sample: 'gmail:YWdlbnRAZXhhbXBsZS5jb20:18c0a1b2c3d4e5f6',
  hint: 'You are answering an email. Write plain text with short paragraphs, no Markdown headings or tables.',
  events: {
    mail: {
      description: 'Email under the watched label from a sender whose domain passes DMARC',
      on: 'mention',
      addressed: true,
    },
  },
  tools: { presets: { observe: [], comment: [], write: [] } },
  get app() {
    return gmailApp;
  },
  auth: {
    token: (installation, credentials, _bound, save) => gmailToken(installation, credentials, save),
    get user() {
      return gmailUserAuth;
    },
  },
  target(req, raw) {
    const app = new URL(req.url).searchParams.get('app');
    const installation = mailbox(raw);
    return app && installation ? { app, installation } : undefined;
  },
  adapter: async ctx => (await import('./adapter')).gmailAdapter(ctx),
  // Watches last 7 days; renewing also catches up on mail whose notification was lost.
  async renew(adapter) {
    await (adapter as GmailAdapter).watch();
    await (adapter as GmailAdapter).sync();
  },
  sync: adapter => (adapter as GmailAdapter).sync(),
  event(type, _thread, message) {
    return authenticated(message.raw as GmailRawMessage)
      ? { type, actor: { id: message.author.userId, login: message.author.userId } }
      : undefined;
  },
};
