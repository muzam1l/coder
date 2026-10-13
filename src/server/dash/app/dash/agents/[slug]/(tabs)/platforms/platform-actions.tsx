'use client';

import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { useRouter } from '@wular/pnext/navigation/client';

import type { CreateStart } from '@coder/client/types';
import type { CreateStep, PlatformPost } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { iAlert, iDots, iDown, iPlus, iSpark, iX } from '@/comps/ui/icons';
import { reasonText } from '@/utils/format';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { CopyLine } from '@/comps/ui/copy';
import { ErrorText, Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Segmented } from '@/comps/ui/segmented';
import { toastError } from '@/comps/frame/task-toasts';

const ISSUES = 'https://github.com/muzam1l/coder/issues/new';

/** Who can install a new app, as the create link's `public`. */
const WHO = {
  private: ['Private', 'Only its owner can install it.'],
  public: [
    'Public',
    'Any account can install it. It only works where a member of this workspace installs it.',
  ],
} as const;

/** Finishes a create with `fields` and goes where the server answers; a navigation, so the CSP's form-action never stops the trip to the platform. */
const finishCreate = (
  integration: string,
  start: () => Promise<CreateStart>,
  fields: Record<string, string> = {},
) =>
  start()
    .then(({ tx }) => client.apps.finish(integration, { ...fields, tx }))
    .then(({ url }) => location.assign(url));

/** Step text with the platform's UI names, marked **like this**, set apart. */
const uiNames = (text: string) =>
  text.split(/\*\*(.+?)\*\*/).map((part, index) =>
    index % 2 ? (
      <span key={index} class="ui-name">
        {part}
      </span>
    ) : (
      part
    ),
  );

/** Posts the platform's own create form, such as GitHub's app manifest. */
export function postTo({ url, fields }: PlatformPost) {
  const form = Object.assign(document.createElement('form'), { method: 'post', action: url });
  for (const [name, value] of Object.entries(fields))
    form.append(Object.assign(document.createElement('input'), { type: 'hidden', name, value }));
  document.body.append(form);
  form.submit();
}

/** The create form for `state`; nothing once the platform's own form is posted. */
export const createForm = (
  catalog: CreateStep | undefined,
  state: Record<string, string>,
  start: () => Promise<CreateStart>,
): Promise<CreateStep | undefined> =>
  catalog && !state.public
    ? Promise.resolve(catalog)
    : start().then(({ post, create }) => (post ? void postTo(post) : (create ?? catalog)));

/** The create link's state with owner and visibility. */
const createState = (createUrl: string, owner = '', isPublic = false) => ({
  ...Object.fromEntries(new URL(createUrl, location.href).searchParams),
  ...(owner ? { owner } : {}),
  ...(isPublic ? { public: '1' } : {}),
});

/** Asks for a public address first; closes `dialog` on the way. */
function Unreachable({ dialog }: { dialog: { current: HTMLDialogElement | null } }) {
  return (
    <p class="flash err">
      This server is only reachable from this machine, so{' '}
      <a
        href="#tunnel"
        onClick={() => {
          dialog.current!.close();
          document.querySelector('#tunnel details')?.setAttribute('open', '');
        }}
      >
        set a public address
      </a>{' '}
      first.
    </p>
  );
}

/** Installs an app, linked to installation `link` when given, and comes back to this page. */
function useInstall() {
  const [busy, setBusy] = useState(false);
  const install = (app: string, link?: string) => {
    setBusy(true);
    void client.apps
      .install(app, location.pathname, link)
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        setBusy(false);
        toastError('Not installed', reasonText(reason));
      });
  };

  return { busy, install };
}

/** One install button, for the next steps of a flow's outcome. */
export function InstallButton({ app, link, label }: { app: string; link?: string; label: string }) {
  const { busy, install } = useInstall();

  return (
    <button
      type="button"
      class="btn sm outline"
      disabled={busy}
      aria-busy={busy}
      onClick={() => install(app, link)}
    >
      {label}
    </button>
  );
}

type AppChoice = { id: string; name: string; public?: true; settingsUrl?: string };

/** Asks before Coder forgets `app`; the app itself stays on the platform until deleted there. */
function RemoveDialog({
  app,
  name,
  onClose,
}: {
  app: AppChoice;
  /** The platform's display name. */
  name: string;
  onClose: () => void;
}) {
  const nav = useRouter();
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true);
    void client.apps
      .remove(app.id)
      .then(() => {
        // An outcome in the address belongs to the removed app.
        history.replaceState(history.state, '', location.pathname);
        nav.refresh();
      })
      .catch(reason => {
        setBusy(false);
        toastError('Not removed', reasonText(reason));
      });
  };

  return (
    <ConfirmDialog
      open
      title={`Remove ${app.name}?`}
      body={
        <>
          Coder forgets this app and its installs here, and the agent stops answering through it on{' '}
          {name}.
          <br />
          Delete the app itself on {name}
          {app.settingsUrl ? (
            <>
              {' '}
              in{' '}
              <a class="link" href={app.settingsUrl} target="_blank" rel="noreferrer">
                its settings
              </a>
            </>
          ) : null}
          .
        </>
      }
      confirmLabel="Remove"
      busy={busy}
      onConfirm={remove}
      onClose={onClose}
    />
  );
}

/** An app's create step as a form; the transaction is taken on submit, so a slow trip to the platform never outlives it. */
export function CreateDialog({
  integration,
  step,
  start,
  unreachable,
  onClose,
}: {
  integration: string;
  step: CreateStep;
  start: () => Promise<CreateStart>;
  /** Platforms cannot reach this server yet. */
  unreachable?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => dialog.current!.showModal(), []);

  const close = () => !busy && dialog.current!.close();
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setBusy(true);
    setError('');
    void finishCreate(integration, start, {
      ...step.hidden,
      ...(Object.fromEntries(new FormData(form)) as Record<string, string>),
    }).catch(reason => {
      setBusy(false);
      setError(reasonText(reason));
    });
  };

  return (
    <dialog
      ref={dialog}
      class="create-dialog"
      aria-labelledby={id}
      onClose={onClose}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <form onSubmit={submit}>
        <header>
          <h2 id={id}>{step.submit}</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>
            <Icon d={iX} />
          </button>
        </header>
        {unreachable ? <Unreachable dialog={dialog} /> : null}
        <p class="muted">{step.intro}</p>
        <a class="btn secondary create-open" href={step.link} target="_blank" rel="noreferrer">
          Open {new URL(step.link).host} ↗
        </a>
        <ol class="create-steps">
          {step.steps.map(({ text, link, copy = [] }) => (
            <li key={text}>
              <p>{uiNames(text)}</p>
              {link && link !== step.link ? (
                <a href={link} target="_blank" rel="noreferrer">
                  {link.replace(/^https:\/\//, '')}
                </a>
              ) : null}
              {copy.map(value => (
                <CopyLine key={value} value={value} label="Copy" />
              ))}
            </li>
          ))}
        </ol>
        {step.notes?.length ? (
          <details class="create-more">
            <summary>Advanced</summary>
            <ul>
              {step.notes.map(note => (
                <li key={note}>{uiNames(note)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {step.fields.map(field => (
          <Field
            key={field.name}
            label={field.label}
            hint={field.hint ?? (field.required ? undefined : 'optional')}
          >
            <input
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              autocomplete="off"
              spellcheck={false}
            />
          </Field>
        ))}
        <ErrorText value={error} />
        <div class="actions">
          <button type="button" class="btn ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button class="btn" disabled={busy} aria-busy={busy}>
            {step.submit}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Who can install the new app and where it lives, asked before the trip to the platform. */
function WhereDialog({
  integration,
  name,
  publicApps,
  organizationApps,
  unreachable,
  onSubmit,
  onClose,
}: {
  integration: string;
  name: string;
  publicApps: boolean;
  organizationApps: boolean;
  unreachable?: boolean;
  onSubmit: (owner: string, isPublic: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [who, setWho] = useState<keyof typeof WHO>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef<HTMLInputElement>(null);

  useEffect(() => dialog.current!.showModal(), []);

  // The first organization the workspace already works in, preselected once read.
  useEffect(() => {
    if (!organizationApps) return;
    void client.installations
      .list(undefined, { limit: 200, active: true })
      .then(rows => {
        const [first] = rows
          .map(row => row.value)
          .filter(
            row =>
              row.integration === integration && row.account.type && row.account.type !== 'User',
          )
          .map(row => row.account.login)
          .sort();
        if (first && owner.current && !owner.current.value) owner.current.value = first;
      })
      .catch(reason => console.error('coder dashboard: installations', reason));
  }, []);

  const close = () => !busy && dialog.current!.close();
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setBusy(true);
    setError('');
    void onSubmit(String(form.get('owner') ?? '').trim(), who === 'public').catch(reason => {
      setBusy(false);
      setError(reasonText(reason));
    });
  };

  return (
    <dialog
      ref={dialog}
      class="create-dialog"
      aria-labelledby={id}
      onClose={onClose}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <form onSubmit={submit}>
        <header>
          <h2 id={id}>Create {name} app</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>
            <Icon d={iX} />
          </button>
        </header>
        {unreachable ? <Unreachable dialog={dialog} /> : null}
        {publicApps ? (
          <Field label="Who can install it" group>
            <Segmented
              label="Who can install it"
              options={Object.entries(WHO).map(([key, [text]]) => [key, text])}
              value={who}
              onChange={value => setWho(value as keyof typeof WHO)}
              disabled={busy}
            />
            <small class="where-note">{WHO[who][1]}</small>
          </Field>
        ) : null}
        {organizationApps ? (
          <Field label="Organization" hint="Leave empty to own it on your personal account.">
            <input
              ref={owner}
              name="owner"
              placeholder="your-org"
              autocomplete="off"
              spellcheck={false}
            />
          </Field>
        ) : null}
        <ErrorText value={error} />
        <div class="actions">
          <button type="button" class="btn ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button class="btn" disabled={busy} aria-busy={busy}>
            Continue to {name}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** An unexpected setup failure, open on load: try again, or report it. */
function FailedDialog({ name, onRetry }: { name: string; onRetry: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const title = `Setting up ${name} failed`;

  useEffect(() => dialog.current!.showModal(), []);

  return (
    <dialog
      ref={dialog}
      class="create-dialog failed-dialog"
      aria-labelledby={id}
      // A reload must not show it again.
      onClose={() => history.replaceState(history.state, '', location.pathname)}
      onClick={event => event.target === event.currentTarget && dialog.current!.close()}
    >
      <form method="dialog">
        <header>
          <Icon d={iAlert} />
          <h2 id={id}>{title}</h2>
        </header>
        <p>
          Coder ran into an unexpected error, so nothing was set up. Try again, and if it fails
          again, report it on GitHub.
        </p>
        <div class="actions">
          <button class="btn ghost">Close</button>
          <a
            class="btn outline"
            href={`${ISSUES}?title=${encodeURIComponent(title)}`}
            target="_blank"
            rel="noreferrer"
          >
            Report issue
          </a>
          <button
            type="button"
            class="btn"
            autofocus
            onClick={() => {
              dialog.current!.close();
              onRetry();
            }}
          >
            Try again
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The one next step for a platform, and the rarer ones in its row menu. */
export function PlatformActions({
  integration,
  name,
  apps,
  installed,
  createUrl,
  create,
  unreachable,
  publicApps = false,
  organizationApps = false,
  shared = false,
  failed,
}: {
  integration: string;
  /** The platform's display name. */
  name: string;
  apps: AppChoice[];
  installed: boolean;
  createUrl: string;
  /** The form that creates the app here; without one, creation happens on the platform. */
  create?: CreateStep;
  unreachable?: boolean;
  /** Apps may be installable by any account; Create app asks first. */
  publicApps?: boolean;
  /** Apps may live under an organization; Create app asks which. */
  organizationApps?: boolean;
  /** The apps are this server's shared ones, installed but never created here. */
  shared?: boolean;
  /** The platform's last setup failed unexpectedly, on `app` when it was an install. */
  failed?: { name: string; app?: string };
}) {
  const { busy, install } = useInstall();
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState<{ state: Record<string, string>; step: CreateStep }>();
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState<AppChoice>();
  const asks = publicApps || organizationApps;
  // Creation on the platform: the browser posts the platform's own form, such as GitHub's manifest.
  const createThere = (state: Record<string, string>) => {
    setLeaving(true);
    return client.apps
      .create(integration, state)
      .then(({ post }) => post && postTo(post))
      .catch(reason => {
        setLeaving(false);
        throw reason;
      });
  };
  // A step with nothing to fill in, such as signing in through a shared client, finishes with no dialog.
  const createNow = (state: Record<string, string>) => {
    setLeaving(true);
    return finishCreate(
      integration,
      () => client.apps.create(integration, state),
      create!.hidden,
    ).catch(reason => {
      setLeaving(false);
      throw reason;
    });
  };
  // The create form, when there is one, takes over from the where dialog.
  const begin = (state: Record<string, string>) =>
    !create
      ? createThere(state)
      : create.fields.length
        ? createForm(create, state, () => client.apps.create(integration, state)).then(step => {
            if (!step) return;
            setCreating({ state, step });
            setAsking(false);
          })
        : createNow(state);
  const start = () =>
    asks
      ? setAsking(true)
      : void begin(createState(createUrl)).catch(reason =>
          toastError('App not created', reasonText(reason)),
        );
  const dialog = creating ? (
    <CreateDialog
      integration={integration}
      step={creating.step}
      start={() => client.apps.create(integration, creating.state)}
      unreachable={unreachable}
      onClose={() => setCreating(undefined)}
    />
  ) : null;
  const where = asking ? (
    <WhereDialog
      integration={integration}
      name={name}
      publicApps={publicApps}
      organizationApps={organizationApps}
      unreachable={unreachable}
      onSubmit={(owner, isPublic) => begin(createState(createUrl, owner, isPublic))}
      onClose={() => setAsking(false)}
    />
  ) : null;
  // Gone once the refreshed list no longer holds the app.
  const removal =
    removing && apps.some(app => app.id === removing.id) ? (
      <RemoveDialog app={removing} name={name} onClose={() => setRemoving(undefined)} />
    ) : null;
  const failure = failed ? (
    <FailedDialog
      name={failed.name}
      onRetry={() => (apps.some(app => app.id === failed.app) ? install(failed.app!) : start())}
    />
  ) : null;
  if (!apps.length)
    return (
      <>
        <button type="button" class="btn sm" disabled={leaving} aria-busy={leaving} onClick={start}>
          {create && !create.fields.length ? create.submit : 'Create app'}
        </button>
        {dialog}
        {where}
        {failure}
      </>
    );
  return (
    <>
      <span class="split">
        {installed ? null : (
          <button
            type="button"
            class="btn sm"
            disabled={busy}
            aria-busy={busy}
            onClick={() => install(apps[0]!.id)}
          >
            Install
          </button>
        )}
        <Menu
          summaryClass={installed ? 'icon-btn' : 'btn sm split-more'}
          label={`More for ${integration}`}
          wide
          summary={<Icon d={installed ? iDots : iDown} />}
        >
          {apps.map(app => {
            const named = apps.length > 1 ? ` ${app.name}` : '';

            return (
              <MenuItem
                key={app.id}
                icon={iPlus}
                title={
                  app.public
                    ? `Install${named} on another account`
                    : installed
                      ? `Change${named} access`
                      : `Install${named}`
                }
                sub={
                  app.public
                    ? 'Add it to another account, organization, or workspace.'
                    : installed
                      ? "Choose what it can reach on its owner's account."
                      : 'Install it on the account that owns it.'
                }
                onClick={() => install(app.id)}
              />
            );
          })}
          {shared ? null : (
            <MenuItem
              icon={iSpark}
              onClick={start}
              title={`Create another ${name} app`}
              sub={
                apps.every(app => app.public)
                  ? 'A separate app with its own name.'
                  : 'For another account or organization; private apps install only on their owner.'
              }
            />
          )}
          {shared
            ? null
            : apps.map(app => (
                <MenuItem
                  key={`remove ${app.id}`}
                  icon={iX}
                  title={`Remove ${app.name}`}
                  danger
                  onClick={() => setRemoving(app)}
                />
              ))}
        </Menu>
      </span>
      {dialog}
      {where}
      {removal}
      {failure}
    </>
  );
}
