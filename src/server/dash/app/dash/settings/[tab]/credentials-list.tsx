'use client';

import './credentials-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client, poll } from '@/utils/client';
import { iCheck, iCopy, iDots } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import type { CredentialRow, EngineStatus, Me } from '@coder/client/types';
import { Card, Loading } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import { useRemove } from './list';

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
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'ANTHROPIC_API_KEY',
];
const SCOPES: Array<[string, string]> = [
  ['personal', 'Just me'],
  ['workspace', 'Workspace'],
];
const METHODS: Record<string, string> = { signin: 'Sign in', key: 'API key', token: 'Setup token' };

const ADMIN_ROLES = new Set(['owner', 'admin']);
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
          <button
            type="button"
            class="btn ghost sm"
            aria-busy={busy === 'default'}
            onClick={() => void onAct('default')}
          >
            Make default
          </button>
        )}
        {signIn || removing.item ? (
          <Menu summaryClass="icon-btn" label="Actions" summary={<Icon d={iDots} />}>
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

/** One key field for an engine; Enter saves it. A custom key also names its variable. */
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
  const [scope, setScope] = useState('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, []);
  const save = () => {
    if (busy || !value.trim() || !name.trim()) return;
    setBusy(true);
    setError('');
    void client.credentials
      .add({
        engine: engine.id,
        env: { [token ? 'CLAUDE_CODE_OAUTH_TOKEN' : name.trim()]: value.trim() },
        ...(scope === 'workspace' && !token ? { workspace: true } : {}),
      })
      .then(onSaved)
      .catch(reason => {
        setBusy(false);
        setError(reasonText(reason));
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
        placeholder={
          token ? 'Paste a claude setup-token, then Enter' : `${engine.hint}, then Enter`
        }
        ref={input}
        aria-busy={busy}
        value={value}
        onInput={event => setValue(event.currentTarget.value)}
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
      <ErrorText value={error} />
      <button hidden />
    </form>
  );
}

/** The sign-in button's label, as wide as its widest state so the button never moves. */
function SignInLabel({ engine, label }: { engine: (typeof ENGINES)[number]; label: string }) {
  const all = [
    `Sign in with ${engine.signIn}`,
    `Open ${engine.signIn} sign-in`,
    'Open sign-in page',
    'Open again',
  ];
  return (
    <span class="sign-label" data-all={all.join('\n')}>
      {label}
    </span>
  );
}

/** A subscription sign-in: the official login runs on the server, and the page leads through each step. */
function SignIn({
  login,
  engine,
  onChange,
  onDone,
  onError,
}: {
  login: Login;
  engine: (typeof ENGINES)[number];
  onChange: (next: Login) => void;
  onDone: () => void;
  onError: (reason: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!login.id || login.state === 'done' || login.state === 'failed') return;
    const timer = setTimeout(() => {
      void client.credentials
        .loginStatus(login.id)
        .then(next => {
          if (next.state === 'done') return onDone();
          if (next.state === 'failed') return onError(next.error ?? 'Sign-in failed. Try again.');
          onChange(next);
        })
        .catch(reason => onError(reasonText(reason)));
    }, 800);
    return () => clearTimeout(timer);
  }, [login]);

  const onCode = (code: string) => {
    onChange({ ...login, state: 'verifying' });
    void client.credentials.loginCode(login.id, code).catch(reason => onError(reasonText(reason)));
  };

  if (!login.url)
    return (
      <div class="cred-login grow end" role="status">
        <button type="button" class="btn" disabled aria-busy="true">
          <SignInLabel engine={engine} label={`Sign in with ${engine.signIn}`} />
        </button>
      </div>
    );
  if (login.engine === 'codex')
    return (
      <div class="cred-login grow end" role="status">
        <Loading label="Waiting for approval…" inline />
        <span class="code-box">
          {login.code}
          <button
            type="button"
            class="icon-btn"
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            onClick={() =>
              void navigator.clipboard.writeText(login.code ?? '').then(() => setCopied(true))
            }
          >
            <Icon d={copied ? iCheck : iCopy} />
          </button>
        </span>
        <a class="btn" href={login.url} target="_blank" rel="noopener noreferrer">
          <SignInLabel engine={engine} label="Open sign-in page" />
        </a>
      </div>
    );
  return (
    <div class="cred-login grow end" role="status">
      {opened ? (
        <input
          class="mono"
          autoFocus
          autocomplete="off"
          aria-label={`Code from the ${engine.signIn} sign-in page`}
          placeholder="Paste the code from the sign-in page"
          disabled={login.state === 'verifying'}
          onPaste={event => {
            const code = event.clipboardData?.getData('text').trim();
            if (code) {
              event.preventDefault();
              onCode(code);
            }
          }}
          onKeyDown={event => {
            const code = event.currentTarget.value.trim();
            if (event.key === 'Enter' && code) onCode(code);
          }}
        />
      ) : null}
      <a
        class="btn"
        href={login.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => setOpened(true)}
      >
        <SignInLabel
          engine={engine}
          label={opened ? 'Open again' : `Open ${engine.signIn} sign-in`}
        />
      </a>
    </div>
  );
}

/** A server on this machine: tasks use its own claude and codex logins, so nothing is stored here. */
export function EngineLogins({ status: initial }: { status: EngineStatus }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const waiting = useRef<() => void>();

  // A sign-in finishes in the browser the engine opened; the status says when.
  const watch = (engine: string) => {
    waiting.current?.();
    const until = Date.now() + 5 * 60_000;
    // A status read from a sign-in already stopped never stops the next one.
    let current = true;
    const stopPoll = poll(async () => {
      const next = await client.engines.status();
      if (!current) return;
      setStatus(next);
      if (next[engine as 'claude' | 'codex']?.signedIn || Date.now() > until) {
        stop();
        setBusy('');
      }
    }, 2000);
    const stop = () => {
      current = false;
      stopPoll();
    };
    waiting.current = stop;
  };
  useEffect(() => () => waiting.current?.(), []);
  const act = (engine: string, action: 'login' | 'logout') => {
    setBusy(`${engine}:${action}`);
    setError('');
    client.engines[action](engine)
      .then(next => {
        setStatus(next);
        if (action === 'login') watch(engine);
        else setBusy('');
      })
      .catch(reason => {
        setBusy('');
        setError(reasonText(reason));
      });
  };

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
                <button
                  type="button"
                  class="btn secondary-danger sm"
                  disabled={busy === `${engine.id}:logout`}
                  onClick={() => act(engine.id, 'logout')}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  class="btn secondary sm"
                  aria-busy={signingIn}
                  disabled={Boolean(busy)}
                  onClick={() => act(engine.id, 'login')}
                >
                  Sign in
                </button>
              )}
              {signingIn ? (
                <button
                  type="button"
                  class="btn ghost sm"
                  onClick={() => {
                    waiting.current?.();
                    setBusy('');
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </Card>
        );
      })}
      <ErrorText value={error} />
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
  back,
}: {
  rows: CredentialRow[];
  me: Me;
  focus: string;
  back?: string;
}) {
  const nav = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [adding, setAdding] = useState('');
  const [logins, setLogins] = useState<Partial<Record<Login['engine'], Login>>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const token = !me.user;
  const admin = token || ADMIN_ROLES.has(me.organization?.role ?? '');
  const subscriptions = me.server?.subscriptions;
  useEffect(() => setPending(''), [rows]);

  const setLogin = (engine: Login['engine'], login?: Login) =>
    setLogins(all => ({ ...all, [engine]: login }));

  const done = (engine?: Login['engine']) => {
    if (engine) setLogin(engine);
    setAdding('');
    if (back) location.href = back;
    else nav.refresh();
  };

  const signIn = (engine: Login['engine']) => {
    setError('');
    setLogin(engine, { id: '', engine, state: 'starting' });
    void client.credentials
      .login(engine)
      .then(next => setLogin(engine, next))
      .catch(reason => {
        setLogin(engine);
        setError(reasonText(reason));
      });
  };

  const act = (row: CredentialRow, kind: 'default' | 'remove') => {
    if (pending) return Promise.resolve();
    setPending(`${row.scope}/${row.label}/${kind}`);
    setError('');
    return client.credentials[kind === 'default' ? 'setDefault' : 'remove'](row.label, {
      workspace: row.scope === 'workspace',
    })
      .then(() => nav.refresh())
      .catch(reason => {
        setPending('');
        setError(reasonText(reason));
      });
  };

  return (
    <>
      <ErrorText value={error} />
      {ENGINES.map(engine => {
        const own = rows.filter(row => row.engine === engine.id);
        const canSignIn = engine.id !== 'custom' && !token && Boolean(subscriptions?.[engine.id]);
        const methods = [
          ...(canSignIn ? ['signin'] : []),
          'key',
          ...(engine.id === 'claude' && !canSignIn ? ['token'] : []),
        ];
        const how = chosen[engine.id] ?? methods[0]!;
        const open = !own.length || adding === engine.id;
        const active = engine.id === 'custom' ? undefined : logins[engine.id];
        return (
          <Card
            key={engine.id}
            title={engine.name}
            count={own.length || undefined}
            actions={
              active ? (
                <button
                  type="button"
                  class="btn ghost-danger sm"
                  onClick={() => {
                    setLogin(active.engine);
                    if (active.id) void client.credentials.cancelLogin(active.id).catch(() => {});
                  }}
                >
                  Cancel
                </button>
              ) : own.length && adding !== engine.id ? (
                <button type="button" class="btn ghost sm" onClick={() => setAdding(engine.id)}>
                  Add
                </button>
              ) : null
            }
          >
            <div id={`engine-${engine.id}`} class="cred-engine">
              {engine.id === 'custom' ? (
                <p class="muted cred-note">
                  Custom keys back <a href="/dash/settings/models">custom models</a>. A model uses
                  OPENAI_API_KEY unless it names another variable.
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
              {own.length && engine.id !== 'custom' ? (
                <p class="muted cred-note">
                  Ready. Built-in models run on this key. Add aliases or custom endpoints on{' '}
                  <a href="/dash/settings/models">Models</a>.
                </p>
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
                  {active ? (
                    <SignIn
                      login={active}
                      engine={engine}
                      onChange={next => setLogin(active.engine, next)}
                      onDone={() => done(active.engine)}
                      onError={reason => {
                        setLogin(active.engine);
                        setError(reason);
                      }}
                    />
                  ) : how === 'signin' ? (
                    <div class="cred-login grow end">
                      <button
                        type="button"
                        class="btn"
                        autoFocus={focus === engine.id}
                        onClick={() => signIn(engine.id as 'claude' | 'codex')}
                      >
                        <SignInLabel engine={engine} label={`Sign in with ${engine.signIn}`} />
                      </button>
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
