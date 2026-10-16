'use client';

import './credentials-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client, usePoll } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { iCheck, iDots, iPlus } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import type { CredentialRow, EngineStatus, Me } from '@coder/client/types';
import { Card, Loading } from '@/comps/ui/card';
import { Modal } from '@/comps/ui/modal';
import { reasonText } from '@/utils/format';
import { Badge } from '@/comps/ui/badge';
import { Button, IconButton } from '@/comps/ui/button';
import { CopyButton } from '@/comps/ui/copy';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import { useRemove } from './list';
import { useOrg } from '@/comps/nav/org';
import { isAdmin } from '@/api/types';
import { CUSTOM_PROVIDERS, SCOPES } from '@/app/dash/[org]/settings/model-options';

type Engine = CredentialRow['engine'];
type Login = {
  id: string;
  engine: 'claude' | 'codex';
  state: 'starting' | 'open' | 'verifying' | 'done' | 'failed';
  url?: string;
  code?: string;
  error?: string;
};

const ENGINES: Array<{ id: Engine; name: string; key: string; hint: string; signIn?: string }> = [
  {
    id: 'claude',
    name: 'Claude',
    key: 'ANTHROPIC_API_KEY',
    hint: 'Anthropic API key',
    signIn: 'Claude',
  },
  { id: 'codex', name: 'Codex', key: 'OPENAI_API_KEY', hint: 'OpenAI API key', signIn: 'ChatGPT' },
  { id: 'custom', name: 'Custom', key: 'OPENAI_API_KEY', hint: 'API key' },
];
const CUSTOM_KEYS = [
  'OPENAI_API_KEY',
  ...CUSTOM_PROVIDERS.flatMap(provider => provider.envKey || []),
  'ANTHROPIC_API_KEY',
];
const METHODS: Record<string, string> = { signin: 'Sign in', key: 'API key', token: 'Setup token' };
function Row({
  row,
  busy,
  onAct,
  onSignIn,
  canManage,
}: {
  row: CredentialRow;
  busy: string;
  onAct: (kind: 'default' | 'remove') => Promise<unknown>;
  onSignIn?: () => void;
  canManage: boolean;
}) {
  const subscription = row.label.endsWith('-subscription');
  const account = [row.account?.email, row.account?.plan].filter(Boolean).join(' · ');
  const signIn = subscription && onSignIn;
  const removing = useRemove(
    canManage
      ? {
          label: subscription ? 'Sign out' : 'Remove',
          title: subscription ? `Sign out of ${row.label}?` : `Remove ${row.label}?`,
          body: 'Tasks that use it stop running.',
          onRemove: () => onAct('remove'),
        }
      : undefined,
  );
  return (
    <tr>
      <td>
        <span class="row-title">
          <b>{row.label}</b>
          <Badge>{row.scope}</Badge>
          {row.isDefault ? <Badge tone="acc">default</Badge> : null}
        </span>
        <span class="sub mono">{account ? `${account} · ${row.masked}` : row.masked}</span>
      </td>
      <td class="acts">
        {row.isDefault || !canManage ? null : (
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'default'}
            onClick={() => void onAct('default')}
          >
            Make default
          </Button>
        )}
        {signIn || removing.item ? (
          <Menu button="icon" label="Actions" summary={<Icon d={iDots} />}>
            {signIn ? (
              <>
                <MenuItem title="Sign in again" onClick={signIn} />
                <MenuItem title="Switch account" onClick={signIn} />
              </>
            ) : null}
            {removing.item}
          </Menu>
        ) : null}
        {removing.dialog}
      </td>
    </tr>
  );
}

/** One key field for an engine; Add or Enter saves it. A custom key also names its variable. */
function KeyField({
  engine,
  token,
  admin,
  autoFocus,
  onSaved,
}: {
  engine: (typeof ENGINES)[number];
  /** Take a pasted `claude setup-token` instead of an API key. */
  token?: boolean;
  admin: boolean;
  autoFocus: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(engine.key);
  const [scope, setScope] = useState(admin ? 'workspace' : 'personal');
  const action = useAction({ leaves: true });
  const busy = Boolean(action.pending);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, []);
  const save = () => {
    if (busy || !value.trim() || !name.trim()) return;
    void action.run('save', async () => {
      await client.credentials.add({
        engine: engine.id,
        env: { [token ? 'CLAUDE_CODE_OAUTH_TOKEN' : name.trim()]: value.trim() },
        ...(scope === 'workspace' && !token ? { workspace: true } : {}),
      });
      onSaved();
    });
  };
  return (
    <form
      class="cred-add"
      method="post"
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      {engine.id === 'custom' ? (
        <>
          <Combo
            label="Environment variable"
            name="custom-var"
            class="mono cred-var"
            options={CUSTOM_KEYS}
            placeholder="OPENAI_API_KEY"
            value={name}
            onChange={setName}
          />
        </>
      ) : null}
      <input
        type="password"
        autocomplete="off"
        name={`${engine.id}-${token ? 'token' : 'key'}`}
        aria-label={token ? 'Your claude setup-token' : engine.hint}
        placeholder={token ? 'Paste a claude setup-token' : engine.hint}
        ref={input}
        aria-busy={busy}
        value={value}
        onInput={event => setValue(event.currentTarget.value)}
        required
      />
      {admin ? (
        <Select
          label="Who can use this key"
          options={SCOPES}
          value={token ? 'personal' : scope}
          onChange={setScope}
          disabled={token}
        />
      ) : null}
      <Button type="submit" loading={busy}>
        Add
      </Button>
    </form>
  );
}

/** A subscription sign-in, step by step in a dialog: the official login runs on a private machine and the engine's page approves it. */
function SignIn({
  login,
  engine,
  onChange,
  onDone,
  onError,
  onCancel,
}: {
  login: Login;
  engine: (typeof ENGINES)[number];
  onChange: (next: Login) => void;
  onDone: () => void;
  onError: (reason: string) => void;
  onCancel: () => void;
}) {
  const [openedUrl, setOpenedUrl] = useState<string>();
  // The link a code was pasted for; claude offers a new link when it rejects the code.
  const [sentUrl, setSentUrl] = useState<string>();

  usePoll(
    login.id && login.state !== 'done' && login.state !== 'failed'
      ? signal =>
          client.credentials
            .loginStatus(login.id)
            .then(next => {
              // A status that lands after Cancel or close belongs to a sign-in already gone.
              if (signal.aborted) return;
              if (next.state === 'done') return onDone();
              if (next.state === 'failed')
                return onError(next.error ?? 'Sign-in failed. Try again.');
              // Read before the pasted code landed.
              if (login.state === 'verifying' && next.state === 'open' && next.url === sentUrl)
                return;
              onChange(next);
            })
            .catch(reason => {
              if (signal.aborted) return;
              // A restarting server or a dropped connection only delays the next check.
              const status = (reason as { status?: number }).status;
              if (status === undefined || status >= 500)
                return console.error('coder dashboard: sign-in status', reason);
              onError(reasonText(reason));
            })
      : undefined,
    800,
    [login.id],
  );

  const onCode = (code: string) => {
    setSentUrl(login.url);
    onChange({ ...login, state: 'verifying' });
    void client.credentials.loginCode(login.id, code).catch(reason => onError(reasonText(reason)));
  };

  const ready = Boolean(login.url);
  const verifying = login.state === 'verifying';
  const opened = Boolean(login.url) && openedUrl === login.url;
  const rejected = Boolean(sentUrl) && login.state === 'open' && login.url !== sentUrl;
  const open = `Open ${engine.signIn} sign-in`;

  return (
    <Modal
      class="sign-in"
      title={`Sign in with ${engine.signIn}`}
      cancelDanger
      focus="actions"
      onClose={onCancel}
      actions={
        <Button
          href={login.url}
          external
          variant={opened ? 'outline' : 'primary'}
          loading={!ready}
          autoFocus
          onClick={() => setOpenedUrl(login.url)}
        >
          {opened ? 'Open again' : open}
        </Button>
      }
    >
      <p class="muted">Coder signs in on a private machine and keeps the sign-in for your tasks.</p>
      <ol class="steps-list sign-steps" role="status">
        <li>
          {ready ? (
            'The sign-in machine is ready.'
          ) : (
            <Loading label="Starting the sign-in machine…" inline />
          )}
        </li>
        {login.engine === 'codex' ? (
          <>
            <li>
              Open the sign-in page and enter this code.
              {login.code ? (
                <span class="code-box">
                  {login.code}
                  <CopyButton value={login.code} label="Copy code" />
                </span>
              ) : null}
            </li>
            <li>
              {ready ? (
                <Loading label="Waiting for your approval on the sign-in page…" inline />
              ) : (
                'Approve it there.'
              )}
            </li>
          </>
        ) : (
          <>
            <li>Open the {engine.signIn} sign-in and approve it.</li>
            <li>
              {rejected ? (
                <span class="rejected" role="alert">
                  That code did not work. Open the sign-in again and paste the new code.
                </span>
              ) : (
                'Paste the code it shows.'
              )}
              {/* A new link after a rejected code starts an empty field. */}
              <input
                key={login.url}
                class="mono"
                autocomplete="off"
                aria-label={`Code from the ${engine.signIn} sign-in page`}
                placeholder="Paste the code from the sign-in page"
                disabled={login.state !== 'open'}
                onPaste={event => {
                  const code = event.clipboardData?.getData('text').trim();
                  if (code) {
                    event.preventDefault();
                    event.currentTarget.value = code;
                    onCode(code);
                  }
                }}
                onKeyDown={event => {
                  const code = event.currentTarget.value.trim();
                  if (event.key === 'Enter' && code) onCode(code);
                }}
              />
              {verifying ? <Loading label="Checking the code…" inline /> : null}
            </li>
          </>
        )}
      </ol>
    </Modal>
  );
}

/** A server on this machine: tasks use its own claude and codex logins, so nothing is stored here. */
export function EngineLogins({ status: initial }: { status: EngineStatus }) {
  const [status, setStatus] = useState(initial);
  const action = useAction();
  // A sign-in finishes in the browser the engine opened; the status says when.
  const [watching, setWatching] = useState<{ engine: string; until: number }>();
  const busy = action.pending ?? (watching ? `${watching.engine}:login` : '');

  usePoll(
    watching
      ? async signal => {
          const next = await client.engines.status();
          // A status read from a sign-in already stopped never stops the next one.
          if (signal.aborted) return;
          setStatus(next);
          if (next[watching.engine as 'claude' | 'codex']?.signedIn || Date.now() > watching.until)
            setWatching(undefined);
        }
      : undefined,
    2000,
    [watching],
  );

  const act = (engine: string, kind: 'login' | 'logout') =>
    void action.run(`${engine}:${kind}`, async () => {
      setStatus(await client.engines[kind](engine));
      if (kind === 'login') setWatching({ engine, until: Date.now() + 5 * 60_000 });
    });

  return (
    <>
      {ENGINES.filter(engine => engine.id !== 'custom').map(engine => {
        const own = status[engine.id as 'claude' | 'codex'];
        const signingIn = busy === `${engine.id}:login`;
        return (
          <Card key={engine.id} title={engine.name}>
            <div class="cred-new">
              {own?.signedIn ? (
                <span class="signed grow">
                  <Icon d={iCheck} />
                  Signed in to {engine.name}
                </span>
              ) : signingIn ? (
                <span class="grow muted">
                  Finish signing in in the window {engine.name} opened.
                </span>
              ) : (
                <span class="grow muted">Not signed in on this machine.</span>
              )}
              {own?.signedIn ? (
                <Button
                  variant="secondary"
                  danger
                  size="sm"
                  loading={busy === `${engine.id}:logout`}
                  onClick={() => act(engine.id, 'logout')}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={signingIn}
                  disabled={Boolean(busy)}
                  onClick={() => act(engine.id, 'login')}
                >
                  Sign in
                </Button>
              )}
              {signingIn ? (
                <Button variant="ghost" size="sm" onClick={() => setWatching(undefined)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
      <p class="muted">
        On the local server, custom models read their key variable from this machine's environment.
      </p>
    </>
  );
}

export function CredentialsList({
  rows,
  me,
  focus,
}: {
  rows: CredentialRow[];
  me: Me;
  focus: string;
}) {
  const nav = useRouter();
  const org = useOrg();
  const [adding, setAdding] = useState('');
  const [logins, setLogins] = useState<Partial<Record<Login['engine'], Login>>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const token = !me.user;
  const admin = isAdmin(me);
  const subscriptions = me.server?.subscriptions;
  const action = useAction({ refresh: true, leaves: true });
  // A row's action stays busy until the refreshed rows arrive.
  const [acted, setActed] = useState(rows);
  const pending = acted === rows ? (action.pending ?? '') : '';

  // The tab remembers its sign-ins in progress, so a reload picks them back up.
  const saved = `coder-logins:${org}`;
  const remembered = (): Partial<Record<Login['engine'], string>> => {
    try {
      return JSON.parse(sessionStorage.getItem(saved) ?? '{}');
    } catch {
      return {};
    }
  };
  const setLogin = (engine: Login['engine'], login?: Login) => {
    setLogins(all => ({ ...all, [engine]: login }));
    try {
      const ids = { ...remembered(), [engine]: login?.id || undefined };
      sessionStorage.setItem(saved, JSON.stringify(ids));
    } catch {}
  };

  // A sign-in started on this page wins over a restore still in flight.
  const started = useRef(new Set<Login['engine']>());

  useEffect(() => {
    for (const [engine, id] of Object.entries(remembered()) as [Login['engine'], string][]) {
      void client.credentials
        .loginStatus(id)
        .then(next => {
          if (started.current.has(engine)) return;
          if (next.state === 'done') return done(engine);
          if (next.state === 'failed') {
            setLogin(engine);
            return toastFailure(next.error ?? 'Sign-in failed. Try again.');
          }
          setLogin(engine, next);
        })
        .catch(() => {
          if (!started.current.has(engine)) setLogin(engine);
        });
    }
  }, []);

  const done = (engine?: Login['engine']) => {
    if (engine) setLogin(engine);
    setAdding('');
    nav.refresh();
  };

  const signIn = (engine: Login['engine']) => {
    started.current.add(engine);
    setLogin(engine, { id: '', engine, state: 'starting' });
    void client.credentials
      .login(engine)
      .then(next => setLogin(engine, next))
      .catch(reason => {
        setLogin(engine);
        toastFailure(reason);
      });
  };

  const act = (row: CredentialRow, kind: 'default' | 'remove') => {
    if (pending) return Promise.resolve();
    setActed(rows);
    return action.run(`${row.scope}/${row.label}/${kind}`, () =>
      client.credentials[kind === 'default' ? 'setDefault' : 'remove'](row.label, {
        workspace: row.scope === 'workspace',
      }),
    );
  };

  return (
    <>
      {ENGINES.map(engine => {
        const own = rows.filter(row => row.engine === engine.id);
        const canSignIn = engine.id !== 'custom' && !token && Boolean(subscriptions?.[engine.id]);
        // A setup-token is a subscription too, so it comes and goes with subscription sign-in.
        const methods = [
          ...(canSignIn ? ['signin', ...(engine.id === 'claude' ? ['token'] : [])] : []),
          'key',
        ];
        const how = chosen[engine.id] ?? methods[0]!;
        const open = !own.length || adding === engine.id;
        const active = engine.id === 'custom' ? undefined : logins[engine.id];
        const ready = own.length > 0 && engine.id !== 'custom';
        const add = !active && own.length > 0 && adding !== engine.id;
        return (
          <Card
            key={engine.id}
            title={engine.name}
            count={own.length || undefined}
            actions={
              ready || add ? (
                <>
                  {ready ? <Badge tone="ok">ready</Badge> : null}
                  {add ? (
                    <IconButton
                      icon={iPlus}
                      label={`Add a ${engine.name} credential`}
                      onClick={() => setAdding(engine.id)}
                    />
                  ) : null}
                </>
              ) : null
            }
          >
            <div id={`engine-${engine.id}`} class="cred-engine">
              {engine.id === 'custom' ? (
                <p class="muted cred-note">
                  Custom keys back <a href={`/dash/${org}/settings/models`}>custom models</a>. A
                  model uses OPENAI_API_KEY unless it names another variable.
                </p>
              ) : null}
              {own.length ? (
                <table class="rows creds">
                  <tbody>
                    {own.map(row => {
                      const key = `${row.scope}/${row.label}/`;
                      return (
                        <Row
                          key={key}
                          row={row}
                          busy={pending.startsWith(key) ? pending.slice(key.length) : ''}
                          canManage={row.scope === 'personal' || admin}
                          onAct={kind => act(row, kind)}
                          {...(canSignIn && row.scope === 'personal'
                            ? { onSignIn: () => signIn(engine.id as 'claude' | 'codex') }
                            : {})}
                        />
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
              {open || active ? (
                <div class="cred-new">
                  {methods.length > 1 ? (
                    <Segmented
                      label={`How to add ${engine.name}`}
                      disabled={Boolean(active)}
                      options={methods.map((method): [string, string] => [
                        method,
                        METHODS[method]!,
                      ])}
                      value={how}
                      onChange={method => setChosen({ ...chosen, [engine.id]: method })}
                    />
                  ) : null}
                  {active || how === 'signin' ? (
                    <div class="cred-login grow end">
                      <Button
                        autoFocus={focus === engine.id}
                        disabled={Boolean(active)}
                        onClick={() => signIn(engine.id as 'claude' | 'codex')}
                      >
                        Sign in with {engine.signIn}
                      </Button>
                      {active ? (
                        <SignIn
                          login={active}
                          engine={engine}
                          onChange={next => setLogin(active.engine, next)}
                          onDone={() => done(active.engine)}
                          onError={reason => {
                            setLogin(active.engine);
                            toastFailure(reason);
                          }}
                          onCancel={() => {
                            setLogin(active.engine);
                            if (active.id)
                              void client.credentials.cancelLogin(active.id).catch(toastFailure);
                          }}
                        />
                      ) : null}
                    </div>
                  ) : (
                    <KeyField
                      key={how}
                      engine={engine}
                      token={how === 'token'}
                      admin={admin}
                      autoFocus={focus === engine.id || Boolean(chosen[engine.id])}
                      onSaved={() => done()}
                    />
                  )}
                </div>
              ) : null}
            </div>
          </Card>
        );
      })}
    </>
  );
}
