'use client';

import './credentials-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client, usePoll } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { iCheck } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import type { CredentialRow, EngineStatus, Me } from '@coder/client/types';
import { Card, Loading } from '@/comps/ui/card';
import { Modal } from '@/comps/ui/modal';
import { reasonText } from '@/utils/format';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { CopyButton } from '@/comps/ui/copy';
import { Icon } from '@/comps/ui/icon';
import { MenuItem } from '@/comps/ui/menu-items';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import { Row, replaceTitle, useReplace } from './list';
import { useOrg } from '@/comps/nav/org';
import { isAdmin } from '@/api/types';
import { CUSTOM_PROVIDERS, SCOPES } from '@/app/dash/[org]/settings/model-options';

type Login = {
  id: string;
  engine: 'claude' | 'codex';
  state: 'starting' | 'open' | 'verifying' | 'done' | 'failed';
  url?: string;
  code?: string;
  error?: string;
};

const ENGINES: Array<{ id: Login['engine']; name: string; key: string; signIn: string }> = [
  { id: 'claude', name: 'Claude', key: 'ANTHROPIC_API_KEY', signIn: 'Claude' },
  { id: 'codex', name: 'Codex', key: 'OPENAI_API_KEY', signIn: 'ChatGPT' },
];
const KEYS = [
  ...ENGINES.map(engine => engine.key),
  ...CUSTOM_PROVIDERS.flatMap(provider => provider.envKey || []),
];

/** The first known variable with no key saved yet, so the form never starts on one that exists. */
const unsaved = (keys: CredentialRow[], saved?: string) =>
  KEYS.find(key => key !== saved && !keys.some(row => row.name === key)) ?? '';

/** One API key by its variable; a variable already saved in that scope asks before it is replaced. */
function KeyForm({
  keys,
  admin,
  focus,
  ask,
}: {
  keys: CredentialRow[];
  admin: boolean;
  /** The engine or variable whose key the page was opened for. */
  focus: string;
  ask: (title: string, run: () => void) => void;
}) {
  const [name, setName] = useState(
    ENGINES.find(engine => engine.id === focus)?.key ??
      (/^[A-Z][A-Z0-9_]*$/.test(focus) ? focus : unsaved(keys)),
  );
  const [scope, setScope] = useState(admin ? 'workspace' : 'personal');
  const input = useRef<HTMLInputElement>(null);
  const action = useAction({ toast: 'Not saved', refresh: true });
  useEffect(() => {
    if (focus) input.current?.focus();
  }, []);

  return (
    <form
      class="cred-add"
      method="post"
      onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const variable = name.trim();
        const value = String(new FormData(form).get('key') ?? '').trim();
        if (!variable || !value) return;
        const save = () =>
          void action.run('add', async () => {
            await client.credentials.add({
              env: { [variable]: value },
              ...(scope === 'workspace' ? { workspace: true } : {}),
            });
            form.reset();
            setName(unsaved(keys, variable));
          });
        if (keys.some(row => row.name === variable && row.scope === scope))
          ask(replaceTitle(variable, scope), save);
        else save();
      }}
    >
      <Combo
        label="Variable"
        name="name"
        class="mono cred-var"
        options={KEYS}
        placeholder="OPENAI_API_KEY"
        value={name}
        onChange={setName}
      />
      <input
        type="password"
        name="key"
        autocomplete="off"
        aria-label="API key"
        placeholder="API key"
        ref={input}
        aria-busy={Boolean(action.pending)}
        required
      />
      {admin ? (
        <Select label="Who can use this key" options={SCOPES} value={scope} onChange={setScope} />
      ) : null}
      <Button type="submit" loading={Boolean(action.pending)}>
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

  const verifying = login.state === 'verifying';
  const rejected = Boolean(sentUrl) && login.state === 'open' && login.url !== sentUrl;

  return (
    <Modal
      class="sign-in"
      title={`Sign in with ${engine.signIn}`}
      cancelDanger
      onClose={onCancel}
    >
      <p class="muted">Coder signs in on a private machine and keeps the sign-in for your tasks.</p>
      <div class="sign-link">
        {login.url ? (
          <>
            <Button href={login.url} external autoFocus>
              Open {new URL(login.url).host}
            </Button>
            <CopyButton value={login.url} label="Copy link" />
          </>
        ) : (
          <Loading label="Starting the sign-in machine…" inline />
        )}
      </div>
      <ol class="steps-list sign-steps" role="status">
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
              {login.url ? (
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
      {ENGINES.map(engine => {
        const own = status[engine.id];
        const signingIn = busy === `${engine.id}:login`;
        return (
          <Card look="filled" key={engine.id} title={engine.name}>
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
  const [logins, setLogins] = useState<Partial<Record<Login['engine'], Login>>>({});
  const [pasting, setPasting] = useState(false);
  const admin = isAdmin(me);
  const signIns = ENGINES.filter(engine => me.user && me.server?.subscriptions?.[engine.id]);
  const keys = rows.filter(row => !row.subscription);
  const action = useAction({ refresh: true });
  const replace = useReplace();

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

  const done = (engine: Login['engine']) => {
    setLogin(engine);
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

  const subscription = (engine: Login['engine']) =>
    rows.find(row => row.subscription && row.name === engine);
  // One subscription per engine: a new one asks before it replaces the saved one.
  const replacing = (engine: (typeof ENGINES)[number], run: () => void) =>
    subscription(engine.id) ? replace.ask(`Replace the personal ${engine.name} subscription?`, run) : run();
  const remove = (row: CredentialRow) =>
    action.run(`remove:${row.scope}/${row.name}`, () =>
      client.credentials.remove(row.name, { workspace: row.scope === 'workspace' }),
    );

  return (
    <>
      {signIns.length ? (
        <Card look="filled" title="Subscriptions">
          <div class="cred-engine">
            <p class="muted cred-note">
              Personal: each member signs in with their own. A subscription runs its owner's tasks,
              and platform turns from accounts connected on{' '}
              <a class="link" href={`/dash/${org}/settings/connections`}>
                Connections
              </a>
              .
            </p>
            <table class="rows creds">
              <tbody>
                {signIns.map(engine => {
                  const row = subscription(engine.id);
                  const active = logins[engine.id];
                  const account = [row?.account?.email, row?.account?.plan];
                  return (
                    <Row
                      key={engine.id}
                      title={engine.name}
                      sub={row ? account.filter(Boolean).join(' · ') : undefined}
                      actions={
                        <>
                          {row ? (
                            <span class="signed">
                              <Icon d={iCheck} />
                              Connected
                            </span>
                          ) : (
                            <Button
                              autoFocus={focus === engine.id}
                              disabled={Boolean(active)}
                              onClick={() => signIn(engine.id)}
                            >
                              Sign in with {engine.signIn}
                            </Button>
                          )}
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
                                  void client.credentials
                                    .cancelLogin(active.id)
                                    .catch(toastFailure);
                              }}
                            />
                          ) : null}
                        </>
                      }
                      alignMenu
                      menu={
                        row || engine.id === 'claude' ? (
                          <>
                            {row ? (
                              <MenuItem
                                title="Sign in again"
                                disabled={Boolean(active)}
                                onClick={() => replacing(engine, () => signIn(engine.id))}
                              />
                            ) : null}
                            {engine.id === 'claude' ? (
                              <MenuItem
                                title="Paste a setup token"
                                onClick={() => setPasting(true)}
                              />
                            ) : null}
                          </>
                        ) : undefined
                      }
                      remove={
                        row
                          ? {
                              label: 'Sign out',
                              title: `Sign out of ${engine.name}?`,
                              body: 'Tasks that use it stop running.',
                              onRemove: () => remove(row),
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </tbody>
            </table>
            {pasting ? (
              <div class="cred-new">
                <form
                  class="cred-add"
                  method="post"
                  onSubmit={event => {
                    event.preventDefault();
                    const token = String(new FormData(event.currentTarget).get('token') ?? '');
                    if (!token.trim()) return;
                    replacing(
                      ENGINES[0]!,
                      () =>
                        void action.run('token', async () => {
                          await client.credentials.add({
                            env: { CLAUDE_CODE_OAUTH_TOKEN: token.trim() },
                          });
                          setPasting(false);
                        }),
                    );
                  }}
                >
                  <input
                    type="password"
                    name="token"
                    autocomplete="off"
                    aria-label="Your claude setup-token"
                    placeholder="Paste a claude setup-token"
                    ref={input => input?.focus()}
                    required
                  />
                  <Button type="submit" loading={action.pending === 'token'}>
                    Add
                  </Button>
                </form>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
      <Card look="filled" title="API keys" count={keys.length || undefined}>
        <div class="cred-engine">
          <p class="muted cred-note">
            Tasks read each key as its variable. Claude uses ANTHROPIC_API_KEY, Codex uses
            OPENAI_API_KEY, and a{' '}
            <a class="link" href={`/dash/${org}/settings/models`}>
              custom model
            </a>{' '}
            uses the one it names.
          </p>
          {keys.length ? (
            <table class="rows creds">
              <tbody>
                {keys.map(row => (
                  <Row
                    key={`${row.scope}/${row.name}`}
                    title={row.name}
                    badges={<Badge>{row.scope}</Badge>}
                    sub={row.masked}
                    remove={
                      row.scope === 'personal' || admin
                        ? {
                            title: `Remove ${row.name}?`,
                            body: 'Tasks that use it stop running.',
                            link: row.name,
                            onRemove: () => remove(row),
                          }
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          ) : null}
          <div class="cred-new">
            <KeyForm
              keys={keys}
              admin={admin}
              focus={signIns.some(engine => engine.id === focus) ? '' : focus}
              ask={replace.ask}
            />
          </div>
        </div>
      </Card>
      {replace.dialog}
    </>
  );
}
