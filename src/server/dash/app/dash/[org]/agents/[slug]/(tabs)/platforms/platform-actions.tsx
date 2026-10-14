'use client';

import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter } from '@wular/pnext/navigation/client';

import type { AppCheck, CreateStart } from '@coder/client/types';
import type { CreateStep, PlatformPost } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { iAlert, iDots, iDown, iOut, iPlus, iSpark, iSteer, iUpload, iX } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';
import { reasonText } from '@/utils/format';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Badge } from '@/comps/ui/badge';
import { CopyButton, CopyLine } from '@/comps/ui/copy';
import { ErrorText, Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Segmented } from '@/comps/ui/segmented';
import { showToast, toastError } from '@/comps/frame/task-toasts';

/** Who can install a new app, as the create link's `public`, with what owning it then means. */
const WHO = {
  private: {
    text: 'Private',
    note: () => 'Only the account that owns it can install it.',
    owner: 'Owns it and is the only place it installs. Leave empty for your personal account.',
  },
  public: {
    text: 'Public',
    note: (name: string) => `Any account can install it. ${name} asks where on each install.`,
    owner:
      'Manages its settings; it still installs anywhere. Leave empty for your personal account.',
  },
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

/** Asks for a public address first; closes the dialog it sits in on the way. */
function Unreachable() {
  return (
    <p class="flash err">
      This server is only reachable from this machine, so{' '}
      <a
        href="#tunnel"
        onClick={event => {
          event.currentTarget.closest('dialog')!.close();
          document.querySelector('#tunnel details')?.setAttribute('open', '');
        }}
      >
        set a public address
      </a>{' '}
      first.
    </p>
  );
}

/** Installs an app and comes back to this page. */
function useInstall() {
  const [busy, setBusy] = useState(false);
  const install = (app: string) => {
    setBusy(true);
    void client.apps
      .install(app, location.pathname)
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
export function InstallButton({
  app,
  label,
  class: className = 'btn sm outline',
}: {
  app: string;
  label: string;
  class?: string;
}) {
  const { busy, install } = useInstall();

  return (
    <button
      type="button"
      class={className}
      disabled={busy}
      aria-busy={busy}
      onClick={() => install(app)}
    >
      {label}
    </button>
  );
}

type AppChoice = { id: string; name: string; settingsUrl?: string; changed?: boolean };

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    <Modal
      class="create-dialog"
      title={step.submit}
      dismiss
      busy={busy}
      onSubmit={submit}
      onClose={onClose}
      actions={
        <button class="btn" disabled={busy} aria-busy={busy}>
          {step.submit}
          <Icon d={iSteer} />
        </button>
      }
    >
      {unreachable ? <Unreachable /> : null}
      <p class="muted">{step.intro}</p>
      <div class="create-link">
        <a class="btn secondary create-open" href={step.link} target="_blank" rel="noreferrer">
          Open {new URL(step.link).host} ↗
        </a>
        <CopyButton value={step.link} label="Copy link" />
      </div>
      <ol class="create-steps">
        {step.steps.map(({ text, link, copy = [] }) => (
          <li key={text}>
            <p>{uiNames(text)}</p>
            {link && link !== step.link ? (
              <div class="create-link">
                <a href={link} target="_blank" rel="noreferrer">
                  {link.replace(/^https:\/\//, '')}
                </a>
                <CopyButton value={link} label="Copy link" />
              </div>
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
    </Modal>
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
  const [who, setWho] = useState<keyof typeof WHO>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef<HTMLInputElement>(null);

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
    <Modal
      class="create-dialog"
      title={`Create ${name} app`}
      dismiss
      busy={busy}
      onSubmit={submit}
      onClose={onClose}
      actions={
        <button class="btn" disabled={busy} aria-busy={busy}>
          Continue to {name}
          <Icon d={iOut} />
        </button>
      }
    >
      {unreachable ? <Unreachable /> : null}
      {publicApps ? (
        <Field label="Who can install it" group>
          <Segmented
            label="Who can install it"
            options={Object.entries(WHO).map(([key, { text }]) => [key, text])}
            value={who}
            onChange={value => setWho(value as keyof typeof WHO)}
            disabled={busy}
          />
          <small class="where-note">{WHO[who].note(name)}</small>
        </Field>
      ) : null}
      {organizationApps ? (
        <Field label="Owner" hint={WHO[who].owner}>
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
    </Modal>
  );
}

/** What to change on the platform for an app Coder cannot push; values confirmed by hand where the platform cannot be read. */
function UpdateDialog({
  app,
  name,
  check,
  onClose,
}: {
  app: AppChoice;
  /** The platform's display name. */
  name: string;
  check: AppCheck;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = !check.changed;
  const confirm = (event: MouseEvent) => {
    const dialog = (event.currentTarget as HTMLElement).closest('dialog')!;
    setBusy(true);
    void client.apps
      .update(app.id)
      .then(() => dialog.close())
      .catch(reason => {
        setBusy(false);
        toastError(`${name} app not updated`, reasonText(reason));
      });
  };

  return (
    <Modal
      class="create-dialog"
      title={`Update ${app.name} on ${name}`}
      busy={busy}
      cancel={current ? 'Close' : 'Cancel'}
      onClose={onClose}
      actions={
        current && !check.confirm ? null : (
          <>
            {check.confirm && !current ? (
              <button
                type="button"
                class="btn secondary"
                disabled={busy}
                aria-busy={busy}
                onClick={confirm}
              >
                I updated it
              </button>
            ) : null}
            <a class="btn" href={check.url} target="_blank" rel="noreferrer">
              {check.label} ↗
            </a>
          </>
        )
      }
    >
      {check.confirm ? (
        <>
          <p class="muted">
            {current
              ? `Up to date on ${name}. The app uses these values.`
              : `${name} cannot show Coder the app's settings. Enter the values marked changed in the app on ${name}, then confirm.`}
          </p>
          <ul class="create-steps update-values">
            {check.lines.map(({ text, copy, changed }) => (
              <li key={`${text} ${copy}`}>
                <p>
                  {text} {changed ? <Badge tone="warn">changed</Badge> : null}
                </p>
                {copy ? <CopyLine value={copy} label="Copy" /> : null}
              </li>
            ))}
          </ul>
        </>
      ) : current ? (
        <p>Up to date on {name}.</p>
      ) : (
        <>
          <p class="muted">
            The app on {name} differs from what the agent needs now. Make these changes in its
            settings and save them.
          </p>
          <ol class="create-steps">
            {check.lines.map(({ text, copy }) => (
              <li key={text}>
                <p>{uiNames(text)}</p>
                {copy ? <CopyLine value={copy} label="Copy" /> : null}
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}

/** The update dialog of each app a publish left needing changes on its platform, one at a time. */
export function DriftQueue({ apps }: { apps: Array<AppChoice & { platform: string }> }) {
  const nav = useRouter();
  const [left, setLeft] = useState(apps);
  const [check, setCheck] = useState<AppCheck>();
  const app = left[0];
  const next = () => setLeft(rest => rest.slice(1));

  useEffect(() => {
    setCheck(undefined);
    // A reload must not open them again; the page refreshes once all are closed.
    if (!app) {
      history.replaceState(history.state, '', location.pathname);
      nav.refresh();
      return;
    }
    void client.apps
      .drift(app.id)
      .then(setCheck)
      .catch(reason => {
        toastError(`Not read from ${app.platform}`, reasonText(reason));
        next();
      });
  }, [app?.id]);

  return app && check ? (
    <UpdateDialog app={app} name={app.platform} check={check} onClose={next} />
  ) : null;
}

/** An unexpected setup failure, open on load: try again, or report it. */
function FailedDialog({
  name,
  issues,
  onRetry,
}: {
  name: string;
  /** Where to report it. */
  issues?: string;
  onRetry: () => void;
}) {
  const title = `Setting up ${name} failed`;
  const retry = (event: MouseEvent) => {
    event.currentTarget!.closest('dialog')!.close();
    onRetry();
  };

  return (
    <Modal
      class="outcome-dialog"
      tone="error"
      title={title}
      icon={iAlert}
      cancel="Close"
      focus="actions"
      // A reload must not show it again.
      onClose={() => history.replaceState(history.state, '', location.pathname)}
      actions={
        <>
          {issues ? (
            <a
              class="btn outline"
              href={`${issues}?title=${encodeURIComponent(title)}`}
              target="_blank"
              rel="noreferrer"
            >
              Report issue
            </a>
          ) : null}
          <button type="button" class="btn" autofocus onClick={retry}>
            Try again
          </button>
        </>
      }
    >
      <p>
        Coder ran into an unexpected error, so nothing was set up. Try again, and if it fails again,
        report it on GitHub.
      </p>
    </Modal>
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
  appUpdate,
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
  /** How apps are brought up to date: Coder pushes them, or shows what to change on the platform. */
  appUpdate?: 'push' | 'drift' | 'confirm';
  /** The platform's last setup failed unexpectedly, on `app` when it was an install. */
  failed?: { name: string; app?: string; issues?: string };
}) {
  const nav = useRouter();
  const { busy, install } = useInstall();
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState<{ state: Record<string, string>; step: CreateStep }>();
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState<AppChoice>();
  const [updating, setUpdating] = useState<{ app: AppChoice; check: AppCheck }>();
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
  const update = (app: AppChoice) =>
    appUpdate === 'push'
      ? void client.apps
          .update(app.id)
          .then(() => {
            showToast(`${name} app updated`, `${app.name} now matches the agent.`, 'success');
            nav.refresh();
          })
          .catch(reason => toastError(`${name} app not updated`, reasonText(reason)))
      : void client.apps
          .drift(app.id)
          .then(check => setUpdating({ app, check }))
          .catch(reason => toastError(`Not read from ${name}`, reasonText(reason)));
  // Gone once the refreshed list no longer holds the app.
  const removal =
    removing && apps.some(app => app.id === removing.id) ? (
      <RemoveDialog app={removing} name={name} onClose={() => setRemoving(undefined)} />
    ) : null;
  const failure = failed ? (
    <FailedDialog
      name={failed.name}
      issues={failed.issues}
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
            // The main button already installs the first app.
            if (!installed && app === apps[0]) return null;
            const named = apps.length > 1 ? ` ${app.name}` : '';

            return (
              <MenuItem
                key={app.id}
                icon={iPlus}
                title={`Install${named}`}
                sub={`On its owner's account, or any account if it is public on ${name}.`}
                onClick={() => install(app.id)}
              />
            );
          })}
          {shared ? null : (
            <MenuItem
              icon={iSpark}
              onClick={start}
              title={`Create another ${name} app`}
              sub="A separate app with its own name."
            />
          )}
          {shared || !appUpdate
            ? null
            : apps.map(app => (
                <MenuItem
                  key={`update ${app.id}`}
                  icon={iUpload}
                  title={apps.length > 1 ? `Update ${app.name} on ${name}` : `Update on ${name}`}
                  sub={app.changed ? 'Changed since last update' : undefined}
                  onClick={() => update(app)}
                />
              ))}
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
      {updating ? (
        <UpdateDialog
          app={updating.app}
          name={name}
          check={updating.check}
          // What the check stored shows in the row menu.
          onClose={() => {
            setUpdating(undefined);
            nav.refresh();
          }}
        />
      ) : null}
    </>
  );
}
