import './layout.css';
import { CoderError } from '@coder/core/errors';
import type { ComponentChildren } from 'preact';
import { redirect } from '@wular/pnext/navigation';

import { AuthPanel } from '@/comps/frame/auth-panel';
import {
  iActivity,
  iAgent,
  iChart,
  iKey,
  iMonitor,
  iMoon,
  iOut,
  iPlug,
  iPlus,
  iSliders,
  iSpark,
  iSun,
  iTerminal,
  iUpdown,
  iUser,
  iUsers,
} from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { load, orgOf, signedOut } from '@/api/load';
import type { Me } from '@coder/client/types';
import { initial } from '@/utils/format';
import { Icon, Mark } from '@/comps/ui/icon';
import { ThemeChoices } from '@/comps/frame/theme-choices';
import { Drawer } from '@/comps/frame/drawer';
import { SignOut } from '@/app/dash/[org]/account/sign-out';
import { CurrentLink } from '@/comps/nav/current-link';
import { SideToggle } from '@/comps/nav/side-toggle';
import { linkOf, type To } from '@/comps/nav/to';
import { Menu } from '@/comps/ui/menu';
import {
  MenuHead,
  MenuItem,
  MenuLabel,
  MenuLink,
  MenuNote,
  MenuRadio,
} from '@/comps/ui/menu-items';
import { Button } from '@/comps/ui/button';
import { ActiveCount, TaskToasts } from '@/comps/frame/task-toasts';
import { ForeignLink } from '@/comps/frame/foreign-link';

// Four places; the workspace lives in the account menu.
const nav = (org: string): Array<To & { within: string; label: string; icon: string }> => [
  {
    href: '/dash/[org]/agents',
    params: { org },
    within: `/dash/${org}/agents`,
    label: 'Agents',
    icon: iAgent,
  },
  {
    href: '/dash/[org]/tasks',
    params: { org },
    within: `/dash/${org}/tasks`,
    label: 'Tasks',
    icon: iActivity,
  },
  {
    href: '/dash/[org]/usage',
    params: { org },
    within: `/dash/${org}/usage`,
    label: 'Usage',
    icon: iChart,
  },
  {
    href: '/dash/[org]/settings/[tab]',
    params: { org, tab: 'connections' },
    within: `/dash/${org}/settings`,
    label: 'Settings',
    icon: iSliders,
  },
];

/** A local server leads with Tasks, a cloud one with Agents. */
const navFor = (local: boolean, org: string) => {
  const all = nav(org);

  return local ? [all[1]!, all[0]!, ...all.slice(2)] : all;
};

function themeOf(request: Request) {
  const value = (request.headers.get('cookie') ?? '').match(/(?:^|; )theme=(\w+)/)?.[1];

  return value === 'light' || value === 'dark' ? value : 'system';
}

function ThemeMenu({ theme }: { theme: string }) {
  return (
    <Menu
      class="theme"
      label="Theme"
      button="icon"
      summary={
        <>
          <Icon d={iSun} class="sun" />
          <Icon d={iMoon} class="moon" />
          <Icon d={iMonitor} class="sys" />
        </>
      }
    >
      <MenuLabel>Theme</MenuLabel>
      <ThemeChoices theme={theme} />
    </Menu>
  );
}

function AccountMenu({ me, org }: { me: Me; org: string }) {
  const tokenMode = !me.user;
  const organizations = me.organizations ?? [];

  return (
    <Menu
      label="Account"
      summaryClass="avatar-btn"
      summary={tokenMode ? <Icon d={iKey} /> : initial(me.user?.name)}
    >
      <MenuHead
        icon={<span class="avatar">{tokenMode ? <Icon d={iKey} /> : initial(me.user?.name)}</span>}
        title={tokenMode ? 'Admin token' : me.user?.name}
        sub={
          tokenMode
            ? me.mode === 'local'
              ? 'Local server'
              : 'Local memory server'
            : me.user?.email
        }
      />
      {me.mode === 'local' ? null : <MenuLabel>Workspace</MenuLabel>}
      {me.mode === 'local' ? null : organizations.length ? (
        organizations.map(organization => {
          const current = organization.id === me.organization?.id;

          // A full load, so nothing of this workspace's pages carries over.
          return (
            <MenuRadio
              key={organization.id}
              on={current}
              disabled={current}
              href={`/dash/${encodeURIComponent(organization.slug)}`}
              icon={<span class="org">{initial(organization.name)}</span>}
            >
              {organization.name}
              <small>{organization.role}</small>
            </MenuRadio>
          );
        })
      ) : (
        <MenuItem
          disabled
          icon={
            <span class="org">
              <Icon d={iKey} />
            </span>
          }
          title={
            <>
              {me.organization?.name ?? 'Local server'}
              <small>{tokenMode ? 'one workspace' : me.organization?.role}</small>
            </>
          }
        />
      )}
      {me.manageMembersUrl ? (
        <MenuItem href={me.manageMembersUrl} icon={iUsers} title="Members" external />
      ) : null}
      <hr />
      <MenuLink href="/dash/[org]/account" params={{ org }} icon={iUser}>
        Account
      </MenuLink>
      {me.operator ? (
        <MenuLink href="/dash/[org]/operator" params={{ org }} icon={iKey}>
          Operator
        </MenuLink>
      ) : null}
      <hr />
      {tokenMode ? (
        <form action="/dash/token" method="post">
          <input type="hidden" name="token" value="" />
          <input type="hidden" name="return" value="/dash" />
          <MenuItem type="submit" icon={iOut} title="Forget token" />
        </form>
      ) : (
        <SignOut menu />
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
      <MenuLabel>Server</MenuLabel>
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
      {memory && !local ? <MenuNote>Nothing persists across restarts.</MenuNote> : null}
    </Menu>
  );
}

/** Every create action in one place; each opens its page's own form. */
function CreateMenu({ org }: { org: string }) {
  const settings = (tab: string) => ({
    href: '/dash/[org]/settings/[tab]' as const,
    params: { org, tab },
  });

  return (
    <Menu
      class="create"
      label="Create"
      button={{ wide: true }}
      summary={
        <>
          <Icon d={iPlus} />
          Create
        </>
      }
    >
      <MenuLink href="/dash/[org]/tasks" params={{ org }} search={{ new: '' }} icon={iActivity}>
        New task
      </MenuLink>
      <MenuLink href="/dash/[org]/agents/new" params={{ org }} icon={iAgent}>
        New agent
      </MenuLink>
      <MenuLink {...settings('connections')} search={{ add: '' }} icon={iPlug}>
        Add connection
      </MenuLink>
      <MenuLink {...settings('models')} search={{ add: '' }} icon={iSpark}>
        Add model
      </MenuLink>
      <MenuLink {...settings('credentials')} icon={iKey}>
        Add credential
      </MenuLink>
      <MenuLink {...settings('runners')} icon={iTerminal}>
        Add runner
      </MenuLink>
    </Menu>
  );
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
        <Button type="submit" wide>
          Open dashboard
        </Button>
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
  const org = orgOf(request);
  const { host, searchParams } = new URL(request.url);
  const link = searchParams.get('link');
  const me = load(request).me();
  const side = /(?:^|; )side=(min|max)(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1];

  return (
    <div class={side === 'min' ? 'app side-min' : 'app'}>
      {side ? null : <script dangerouslySetInnerHTML={{ __html: SIDE_AUTO }} />}
      <header class="top">
        <div class="top-l">
          <Drawer />
          <Link class="brand" href="/dash/[org]" params={{ org }}>
            <Mark />
            <span class="lockup">
              Coder <small>wular</small>
            </span>
          </Link>
        </div>
        <div class="top-r">
          <ThemeMenu theme={themeOf(request)} />
          <WithMe me={me}>{who => (who ? <AccountMenu me={who} org={org} /> : null)}</WithMe>
        </div>
      </header>
      <aside class="side">
        <div class="side-main">
          <CreateMenu org={org} />
          <nav aria-label="Dashboard">
            {navFor(request.headers.get('x-coder-mode') === 'local', org).map(
              ({ within, label, icon, ...to }) => (
                <CurrentLink key={within} {...linkOf(to)} within={within} data-tip={label}>
                  <Icon d={icon} />
                  {label}
                  {label === 'Tasks' ? <ActiveCount /> : null}
                  {label === 'Settings' ? (
                    <WithMe me={me}>
                      {who =>
                        who?.reconnect ? (
                          <i class="dot" title="A connection needs reconnecting" />
                        ) : null
                      }
                    </WithMe>
                  ) : null}
                </CurrentLink>
              ),
            )}
          </nav>
        </div>
        <div class="side-foot">
          <SideToggle collapsed={side === 'min'} />
          <WithMe me={me}>{who => <ServerMenu me={who} host={host} />}</WithMe>
        </div>
      </aside>
      <main data-pnext-root>{children}</main>
      <TaskToasts />
      {link?.startsWith('/dash/') ? <ForeignLink link={link} /> : null}
      <Gate me={me} request={request} />
    </div>
  );
}
