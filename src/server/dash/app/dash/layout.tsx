import './layout.css';
import { CoderError } from '@coder/core/errors';
import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';
import { redirect } from '@wular/pnext/navigation';

import { AuthPanel } from '@/comps/frame/auth-panel';
import {
  iActivity,
  iAgent,
  iChart,
  iCheck,
  iKey,
  iMonitor,
  iMoon,
  iOut,
  iSliders,
  iSun,
  iUpdown,
  iUser,
  iUsers,
} from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { load, signedOut } from '@/api/load';
import { localServer } from '@/api/types';
import type { TasksPage, Me } from '@coder/client/types';
import { initial } from '@/utils/format';
import { Icon, Mark } from '@/comps/ui/icon';
import { ThemeChoices } from '@/comps/frame/theme-choices';
import { Drawer } from '@/comps/frame/drawer';
import { SignOut } from '@/app/dash/account/sign-out';
import { CurrentLink } from '@/comps/nav/current-link';
import { SideToggle } from '@/comps/nav/side-toggle';
import type { To } from '@/comps/nav/to';
import { Menu } from '@/comps/ui/menu';
import { TaskToasts } from '@/comps/frame/task-toasts';

// Four places; the workspace lives in the account menu.
const NAV: Array<To & { within: string; label: string; icon: string }> = [
  { href: '/dash/agents', params: {}, within: '/dash/agents', label: 'Agents', icon: iAgent },
  { href: '/dash/tasks', params: {}, within: '/dash/tasks', label: 'Tasks', icon: iActivity },
  { href: '/dash/usage', params: {}, within: '/dash/usage', label: 'Usage', icon: iChart },
  {
    href: '/dash/settings/[tab]',
    params: { tab: 'credentials' },
    within: '/dash/settings',
    label: 'Settings',
    icon: iSliders,
  },
];

/** A local server leads with Tasks, a cloud one with Agents. */
const navFor = (local: boolean) => (local ? [NAV[1]!, NAV[0]!, ...NAV.slice(2)] : NAV);

function themeOf(request: Request) {
  const value = (request.headers.get('cookie') ?? '').match(/(?:^|; )theme=(\w+)/)?.[1];

  return value === 'light' || value === 'dark' ? value : 'system';
}

function ThemeMenu({ theme }: { theme: string }) {
  return (
    <Menu
      class="theme"
      label="Theme"
      summaryClass="icon-btn"
      summary={
        <>
          <Icon d={iSun} class="sun" />
          <Icon d={iMoon} class="moon" />
          <Icon d={iMonitor} class="sys" />
        </>
      }
    >
      <p class="pop-label">Theme</p>
      <ThemeChoices theme={theme} />
    </Menu>
  );
}

function AccountMenu({ me }: { me: Me }) {
  const tokenMode = !me.user;
  const organizations = me.organizations ?? [];

  return (
    <Menu
      label="Account"
      summaryClass="avatar-btn"
      summary={tokenMode ? <Icon d={iKey} /> : initial(me.user?.name)}
    >
      <div class="pop-head">
        <span class="avatar">{tokenMode ? <Icon d={iKey} /> : initial(me.user?.name)}</span>
        <div class="grow">
          <b>{tokenMode ? 'Admin token' : me.user?.name}</b>
          <small>
            {tokenMode
              ? me.mode === 'local'
                ? 'Local server'
                : 'Local memory server'
              : me.user?.email}
          </small>
        </div>
      </div>
      {me.mode === 'local' ? null : <p class="pop-label">Workspace</p>}
      {me.mode === 'local' ? null : organizations.length ? (
        organizations.map(organization => {
          const current = organization.id === me.organization?.id;
          return (
            <form key={organization.id} action="/me/organization" method="post">
              <input type="hidden" name="organization" value={organization.slug} />
              <button
                class="pop-item"
                role="menuitemradio"
                aria-checked={current}
                disabled={current}
              >
                <span class="org">{initial(organization.name)}</span>
                <span class="grow">
                  {organization.name}
                  <small>{organization.role}</small>
                </span>
                <Icon d={iCheck} />
              </button>
            </form>
          );
        })
      ) : (
        <div class="pop-item" aria-disabled="true">
          <span class="org">
            <Icon d={iKey} />
          </span>
          <span class="grow">
            {me.organization?.name ?? 'Local server'}
            <small>{tokenMode ? 'one workspace' : me.organization?.role}</small>
          </span>
        </div>
      )}
      {me.manageMembersUrl ? (
        <a class="pop-item" href={me.manageMembersUrl}>
          <Icon d={iUsers} />
          Members ↗
        </a>
      ) : null}
      <hr />
      <Link class="pop-item" href="/dash/account">
        <Icon d={iUser} />
        Account
      </Link>
      <hr />
      {tokenMode ? (
        <form action="/dash/token" method="post">
          <input type="hidden" name="token" value="" />
          <input type="hidden" name="return" value="/dash" />
          <button class="pop-item">
            <Icon d={iOut} />
            Forget token
          </button>
        </form>
      ) : (
        <SignOut class="pop-item" icon>
          Sign out
        </SignOut>
      )}
    </Menu>
  );
}

function ServerMenu({ me, host }: { me?: Me; host: string }) {
  const memory = !me?.user;
  const local = me?.mode === 'local';
  const url = me?.server?.url ?? `https://${host}`;
  const name = local ? 'Local server' : memory ? 'Memory server' : 'Cloud server';

  return (
    <Menu
      class="server"
      align="up"
      label="Server"
      tip={name}
      summary={
        <>
          <i class={memory && !local ? 'dot' : 'dot ok'} />
          <span class="grow" title={`${me?.server?.name ?? 'Coder'} · ${new URL(url).host}`}>
            {name}
          </span>
          <Icon d={iUpdown} />
        </>
      }
    >
      <p class="pop-label">Server</p>
      <dl class="kv">
        <dt>URL</dt>
        <dd>{url}</dd>
        <dt>Webhooks</dt>
        <dd>{url}/hooks</dd>
        <dt>Store</dt>
        <dd>{local ? 'files' : memory ? 'memory' : 'database'}</dd>
        <dt>Access</dt>
        <dd>{memory ? 'admin token' : `session, ${me?.user?.email ?? ''}`}</dd>
      </dl>
      {memory && !local ? <p class="pop-note">Nothing persists across restarts.</p> : null}
    </Menu>
  );
}

async function ActiveCount({ count }: { count: Promise<TasksPage> }) {
  const active = await count.then(page => page.counts?.active).catch(() => undefined);

  return active ? (
    <span class="n" title={`${active} active`}>
      {active}
    </span>
  ) : null;
}

// Without a saved choice, mid-width screens start with the sidebar collapsed, before first paint.
const SIDE_AUTO = `(() => {
  const app = document.currentScript.parentElement;
  const mid = matchMedia('(min-width: 761px) and (max-width: 1279px)');
  const sync = () => /(?:^|; )side=/.test(document.cookie) || app.classList.toggle('side-min', mid.matches);
  sync();
  mid.addEventListener('change', sync);
})()`;

// `serve` opens /dash#token=…: the fragment never reaches the server, so the form posts it while the page loads, busy from first paint.
const TOKEN_FROM_HASH = `(() => {
  const token = /(?:^|&)token=([^&]+)/.exec(location.hash.slice(1))?.[1];
  if (!token) return;
  history.replaceState(null, '', location.pathname + location.search);
  const form = document.getElementById('token-form');
  form.elements.token.value = decodeURIComponent(token);
  form.querySelector('button').setAttribute('aria-busy', 'true');
  form.submit();
})();`;

function TokenPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const rejected = url.searchParams.get('token') === 'rejected';
  const params = new URLSearchParams(url.searchParams);
  params.delete('token');
  const returnTo = `${url.pathname}${params.size ? `?${params}` : ''}`;

  return (
    <AuthPanel
      tag="local server"
      title="Enter the admin token"
      lead="The server printed it when it started. It is the only key to this server."
    >
      <form id="token-form" action="/dash/token" method="post">
        <input type="hidden" name="return" value={returnTo} />
        <label class="field">
          <span>Admin token</span>
          <input class="mono" name="token" type="password" autocomplete="off" required autofocus />
        </label>
        <button class="btn wide">Open dashboard</button>
        {rejected ? (
          <p class="flash err" role="alert">
            That token was not accepted.
          </p>
        ) : null}
      </form>
      <script dangerouslySetInnerHTML={{ __html: TOKEN_FROM_HASH }} />
    </AuthPanel>
  );
}

/** What needs the account waits for it beside the page, so the page's data loads at once. */
async function WithMe({
  me,
  children,
}: {
  me: Promise<Me>;
  children: (me?: Me) => ComponentChildren;
}) {
  return children(await me.catch(() => undefined));
}

/** Covers the frame when the account cannot load: the session ended, or the memory server wants its admin token. */
async function Gate({ me, request }: { me: Promise<Me>; request: Request }) {
  try {
    await me;
    return null;
  } catch (error) {
    const { pathname, search } = new URL(request.url);

    // The session ended after the page was let in: sign in again, and come back here.
    if (signedOut(error)) redirect(`/login?return=${encodeURIComponent(pathname + search)}`);

    // Any other 401 asks for the memory server's admin token.
    if (error instanceof CoderError && error.status === 401) return <TokenPage request={request} />;

    return null;
  }
}

/** The dashboard's frame around its pages. */
export default function DashLayout({
  request,
  children,
}: {
  request?: Request;
  children: ComponentChildren;
}) {
  if (!request) return null;
  const { pathname, host } = new URL(request.url);
  const me = load(request).me();
  const active = load(request).tasks.list({ cursor: '', limit: 1, summary: true, counts: true });
  const side = /(?:^|; )side=(min|max)(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];

  return (
    <div class={side === 'min' ? 'app side-min' : 'app'}>
      {side ? null : <script dangerouslySetInnerHTML={{ __html: SIDE_AUTO }} />}
      <header class="top">
        <div class="top-l">
          <Drawer />
          <Link class="brand" href="/dash">
            <Mark />
            <span class="lockup">
              Coder <small>wular</small>
            </span>
          </Link>
        </div>
        <div class="top-r">
          <ThemeMenu theme={themeOf(request)} />
          <WithMe me={me}>{who => (who ? <AccountMenu me={who} /> : null)}</WithMe>
        </div>
      </header>
      <aside class="side">
        <nav aria-label="Dashboard">
          {navFor(request.headers.get('x-coder-mode') === 'local').map(
            ({ within, label, icon, ...to }) => (
              <CurrentLink key={within} {...to} within={within} data-tip={label}>
                <Icon d={icon} />
                {label}
                {label === 'Tasks' ? (
                  <Suspense fallback={null}>
                    <ActiveCount count={active} />
                  </Suspense>
                ) : null}
              </CurrentLink>
            ),
          )}
        </nav>
        <div class="side-foot">
          <SideToggle collapsed={side === 'min'} />
          <WithMe me={me}>{who => <ServerMenu me={who} host={host} />}</WithMe>
        </div>
      </aside>
      <main data-pnext-root>{children}</main>
      <TaskToasts />
      <Gate me={me} request={request} />
    </div>
  );
}
