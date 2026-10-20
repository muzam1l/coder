'use client';

import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter } from '@wular/pnext/navigation/client';

import type { AppCheck, CreateStart } from '@coder/client/types';
import type { CreateField, CreateStep, PlatformPost } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { iDots, iDown, iOut, iPlus, iSpark, iSteer, iUpload, iX } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';
import { reasonText } from '@/utils/format';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { CopyButton, CopyLine } from '@/comps/ui/copy';
import { Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { showToast, toastError } from '@/comps/frame/task-toasts';
import { OutcomeDialog } from '@/app/dash/[org]/setup/outcome-dialog';

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

/** Focuses a field the form just revealed. */
const focusShown = (input: HTMLInputElement | null) => input?.focus();

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
  const action = useAction({ toast: 'Not installed', leaves: true });
  const install = (app: string) =>
    void action.run('install', async () => {
      location.href = (await client.apps.install(app, location.pathname)).url;
    });

  return { busy: Boolean(action.pending), install };
}

/** One install button, for the next steps of a flow's outcome. */
export function InstallButton({ app, label }: { app: string; label: string }) {
  const { busy, install } = useInstall();

  return (
    <Button loading={busy} onClick={() => install(app)}>
      {label}
    </Button>
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
  const action = useAction({ toast: 'Not removed', refresh: true, leaves: true });
  const remove = () =>
    void action.run('remove', async () => {
      await client.apps.remove(app.id);
      // An outcome in the address belongs to the removed app.
      history.replaceState(history.state, '', location.pathname);
    });

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
      busy={Boolean(action.pending)}
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
  const action = useAction({ leaves: true });
  const busy = Boolean(action.pending);
  const intro = useRef<HTMLParagraphElement>(null);
  const [values, setValues] = useState(() =>
    Object.fromEntries(step.fields.map(field => [field.name, field.options?.[0]?.value ?? ''])),
  );
  const shown = ({ when }: Pick<CreateField, 'when'>) =>
    !when || values[when.field] === when.equals;
  const steps = step.steps.filter(shown);
  const fields = step.fields.filter(shown);
  const choose = (name: string, value: string) => {
    // The dialog keeps its top while the form below grows or shrinks.
    const dialog = intro.current!.closest('dialog')!;
    if (!dialog.style.marginTop) {
      const { top } = dialog.getBoundingClientRect();
      Object.assign(dialog.style, {
        marginTop: `${top}px`,
        maxHeight: `calc(100dvh - ${top + 24}px)`,
      });
    }
    setValues({ ...values, [name]: value });
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    void action.run('create', () =>
      finishCreate(integration, start, {
        ...step.hidden,
        ...(Object.fromEntries(new FormData(form)) as Record<string, string>),
      }),
    );
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
        <Button type="submit" rightIcon={iSteer} loading={busy}>
          {step.submit}
        </Button>
      }
    >
      {unreachable ? <Unreachable /> : null}
      <p ref={intro} class="muted">
        {step.intro}
      </p>
      {fields
        .filter(field => field.options)
        .map(field => (
          <Field key={field.name} label={field.label} hint={field.hint} group>
            <Select
              label={field.label}
              name={field.name}
              options={field.options!.map(({ value, label }) => [value, label])}
              value={values[field.name]}
              onChange={value => choose(field.name, value)}
              disabled={busy}
            />
          </Field>
        ))}
      {steps.length ? (
        <>
          <div class="create-link">
            <Button variant="secondary" class="create-open" href={step.link} external>
              Open {new URL(step.link).host}
            </Button>
            <CopyButton value={step.link} label="Copy link" />
          </div>
          <ol class="create-steps">
            {steps.map(({ text, link, copy = [] }) => (
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
        </>
      ) : null}
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
      {fields
        .filter(field => !field.options)
        .map(field => (
          <Field
            key={field.name}
            label={field.label}
            hint={field.hint ?? (field.required ? undefined : 'optional')}
          >
            <input
              ref={field.when ? focusShown : undefined}
              name={field.name}
              placeholder={field.placeholder}
              required={field.required}
              autocomplete="off"
              spellcheck={false}
            />
          </Field>
        ))}
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
  const action = useAction({ leaves: true });
  const busy = Boolean(action.pending);
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
    void action.run('submit', () =>
      onSubmit(String(form.get('owner') ?? '').trim(), who === 'public'),
    );
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
        <Button type="submit" rightIcon={iOut} loading={busy}>
          Continue to {name}
        </Button>
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
  const action = useAction({ toast: `${name} app not updated`, leaves: true });
  const busy = Boolean(action.pending);
  const current = !check.changed;
  const confirm = (event: MouseEvent) => {
    const dialog = (event.currentTarget as HTMLElement).closest('dialog')!;
    void action.run('confirm', async () => {
      await client.apps.update(app.id);
      dialog.close();
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
              <Button variant="secondary" loading={busy} onClick={confirm}>
                I updated it
              </Button>
            ) : null}
            <Button href={check.url} external>
              {check.label}
            </Button>
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

  const open = (rest: typeof apps) => {
    setLeft(rest);
    setCheck(undefined);
    const [first] = rest;
    // A reload must not open them again; the page refreshes once all are closed.
    if (!first) {
      history.replaceState(history.state, '', location.pathname);
      nav.refresh();
      return;
    }
    void client.apps
      .drift(first.id)
      .then(setCheck)
      .catch(reason => {
        toastError(`Not read from ${first.platform}`, reasonText(reason));
        open(rest.slice(1));
      });
  };
  useEffect(() => open(apps), []);

  return app && check ? (
    <UpdateDialog app={app} name={app.platform} check={check} onClose={() => open(left.slice(1))} />
  ) : null;
}

/** An unexpected setup failure, open on load: try again, or report it. */
function FailedDialog({
  name,
  issues,
  title = `Setting up ${name} failed`,
  text = 'Coder ran into an unexpected error, so nothing was set up. Try again, and if it fails again, report it on GitHub.',
  onRetry,
}: {
  name: string;
  /** Where to report it. */
  issues?: string;
  title?: string;
  text?: string;
  onRetry: () => void;
}) {
  const retry = (event: MouseEvent) => {
    (event.currentTarget as HTMLElement).closest('dialog')!.close();
    onRetry();
  };

  return (
    <OutcomeDialog ok={false} title={title} text={text} issues={issues} focus="actions">
      <Button autofocus onClick={retry}>
        Try again
      </Button>
    </OutcomeDialog>
  );
}

/** The one next step for a platform, and the rarer ones in its row menu. */
export function PlatformActions({
  integration,
  name,
  apps,
  installed,
  reinstall,
  createUrl,
  create,
  unreachable,
  publicApps = false,
  organizationApps = false,
  shared = false,
  appUpdate,
  split = false,
  failed,
}: {
  integration: string;
  /** The platform's display name. */
  name: string;
  apps: AppChoice[];
  installed: boolean;
  /** The app whose every install was removed on the platform. */
  reinstall?: string;
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
  /** Another row's Install has a menu, so this one keeps the same split shape. */
  split?: boolean;
  /** The platform's last setup failed, on `app` when it was an install; `title` and `text` say how, else it was unexpected. */
  failed?: { name: string; app?: string; issues?: string; title?: string; text?: string };
}) {
  const nav = useRouter();
  const { busy, install } = useInstall();
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState<{ state: Record<string, string>; step: CreateStep }>();
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState<AppChoice>();
  const [updating, setUpdating] = useState<{ app: AppChoice; check: AppCheck }>();
  const asks = publicApps || organizationApps;
  const main = apps.find(app => app.id === reinstall) ?? apps[0];
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
      title={failed.title}
      text={failed.text}
      onRetry={() => (apps.some(app => app.id === failed.app) ? install(failed.app!) : start())}
    />
  ) : null;
  if (!apps.length)
    return (
      <>
        <Button size="sm" loading={leaving} onClick={start}>
          {create && !create.fields.length ? create.submit : 'Create app'}
        </Button>
        {dialog}
        {where}
        {failure}
      </>
    );
  // Installing is the only action: a plain button, or the split shape with a disabled caret when other rows' Install has a menu.
  if (shared && !installed && apps.length === 1) {
    const installButton = (
      <Button size="sm" loading={busy} onClick={() => install(main!.id)}>
        {reinstall ? 'Reinstall' : 'Install'}
      </Button>
    );

    return (
      <>
        {split ? (
          <span class="split">
            {installButton}
            <span class="menu">
              <Button size="sm" class="split-more" disabled aria-label="No more actions">
                <Icon d={iDown} />
              </Button>
            </span>
          </span>
        ) : (
          installButton
        )}
        {where}
        {failure}
      </>
    );
  }
  return (
    <>
      <span class="split">
        {installed ? null : (
          <Button size="sm" loading={busy} onClick={() => install(main!.id)}>
            {reinstall ? 'Reinstall' : 'Install'}
          </Button>
        )}
        <Menu
          button={installed ? 'icon' : { size: 'sm', class: 'split-more' }}
          label={`More for ${integration}`}
          wide
          summary={<Icon d={installed ? iDots : iDown} />}
        >
          {apps.map(app => {
            // The main button already installs this app.
            if (!installed && app === main) return null;
            const named = apps.length > 1 ? ` ${app.name}` : '';

            return (
              <MenuItem
                key={app.id}
                icon={iPlus}
                title={installed ? `Install${named} on another account` : `Install${named}`}
                sub={
                  shared
                    ? `Any ${name} account can add it.`
                    : `Any ${name} account if the app is public, else only the account that owns it.`
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
