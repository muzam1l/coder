import './outcome.css';
import type { ComponentChildren } from 'preact';

import type { IntegrationInfo, SetupOutcome } from '@coder/client/types';

/** The outcome a create, install or link flow put in the URL. */
export function readOutcome(search: URLSearchParams): SetupOutcome | undefined {
  const status = search.get('status') as SetupOutcome['status'] | null;
  if (!status) return undefined;

  const value = (name: string) => search.get(name) ?? undefined;

  return {
    status,
    platform: value('platform'),
    account: value('account'),
    app: value('app'),
    appId: value('appId'),
    error: value('error'),
    connect: value('connect')?.split(',').filter(Boolean),
    link: value('link'),
  };
}

export const succeeded = ({ status }: SetupOutcome) =>
  status === 'connected' || status === 'created' || status === 'linked';

function outcomeText({ status, account, app, error }: SetupOutcome, name: string): string {
  switch (status) {
    case 'connected':
      return account ? `Connected to ${account} on ${name}.` : `Connected ${name}.`;
    case 'created':
      return `Created ${app ?? 'the app'} on ${name}. Every workspace on this server can now connect it from its dashboard.`;
    case 'linked':
      return `Linked ${account ?? 'your account'} on ${name} to your Coder account. Mention the agent again to start.`;
    case 'cancelled':
      return `The ${name} install was cancelled, so nothing was connected.`;
    case 'install-expired':
      return `This ${name} install link expired or was already used, so nothing was connected. If an admin approved the app since, install again to finish.`;
    case 'create-expired':
      return `This ${name} app creation link expired or was already used. Start again from the agent's Platforms tab.`;
    case 'link-expired':
      return 'This link is invalid or has expired.';
    case 'unknown-integration':
      return `This server has no ${name} integration.`;
    case 'no-public-url':
      return 'PUBLIC_URL is not set on this server. Set it to the address platforms should call and restart.';
    case 'unknown-app':
      return `This ${name} install does not match any app on this server. Create the app first.`;
    case 'installation-taken':
      return `This ${name} installation is already connected to another workspace. Disconnect it there first.`;
    case 'installation-bound':
      return `${account ?? 'This account'} is already connected to another agent through this server's ${name} app, in this or another workspace. Disconnect it there first.`;
    case 'account-taken':
      return `That ${name} account is connected to someone else.`;
    case 'not-member':
      return 'Only members of the workspace this agent works for can link here.';
    case 'other-workspace':
      return 'This app belongs to another Coder workspace. Ask its owner to invite you.';
    case 'disconnected':
      return `This ${name} installation is no longer connected.`;
    case 'renew-failed':
      return `Connected to ${account ?? name}, but ${name} did not start sending events yet. Coder tries again within the hour.`;
    case 'platform-error':
      return `${name} answered ${error ?? 'with an error'}, so nothing was connected.`;
    case 'missing-code':
      return `${name} sent no authorization code back, so nothing was connected. Try again.`;
    case 'invalid-field':
      return `The ${error ?? 'form'} value is not valid. Check it and create the app again.`;
    case 'not-yours':
      return `That ${name} installation is not one of yours, so nothing was connected.`;
    case 'wrong-account':
      return `That ${name} account belongs to another organization than the app.`;
    case 'no-refresh-token':
      return `${name} sent no refresh token. Remove the app's access from your ${name} account and connect again.`;
    default:
      return `Setting up ${name} failed. Try again.`;
  }
}

/** A flow's outcome in plain words, with its next steps as `children`. */
export function Outcome({
  outcome,
  catalog,
  children,
}: {
  outcome: SetupOutcome;
  catalog: IntegrationInfo[];
  children?: ComponentChildren;
}) {
  const name =
    catalog.find(entry => entry.id === outcome.platform)?.name ??
    outcome.platform ??
    'the platform';

  return (
    <div class="outcome">
      <p class={succeeded(outcome) ? 'flash' : 'flash err'} role="status">
        {outcomeText(outcome, name)}
      </p>
      {children}
    </div>
  );
}
