'use client';

import { useEffect, useRef, useState } from 'preact/hooks';
import { useParams, usePathname, useRouter } from '@wular/pnext/navigation/client';

import type { AppCheck, CreateStart } from '@coder/client/types';
import type { CreateField, CreateStep, PlatformPost } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { iDots, iDown, iOut, iPlus, iSliders, iSteer, iUpload, iX } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';
import { reasonText } from '@/utils/format';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Badge } from '@/comps/ui/badge';
import { Button, type Look } from '@/comps/ui/button';
import { CopyButton, CopyLine } from '@/comps/ui/copy';
import { Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem, MenuLink } from '@/comps/ui/menu-items';
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
function postTo({ url, fields }: PlatformPost) {
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

/** One install button, for the next steps of a flow's outcome and an app's page. */
export function InstallButton({ app, label, ...look }: Look & { app: string; label: string }) {
  const { busy, install } = useInstall();

  return (
    <Button {...look} loading={busy} onClick={() => install(app)}>
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
  const action = useAction({ toast: 'Not removed', leaves: true });
  const remove = () =>
    void action.run('remove', async () => {
      await client.apps.remove(app.id);
      // Up to the Platforms tab, loaded fresh: a copy cached on the way here still lists the app.
      location.replace(location.pathname.replace(/\/[^/]*$/, ''));
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

/** An install by `app`'s name. */
type InstallChoice = { id: string; app: string; account: string };

/** Asks before the app is uninstalled from `install`'s account on the platform; a refusal links where to do it by hand. */
function UninstallDialog({
  install,
  name,
  onClose,
}: {
  install: InstallChoice;
  /** The platform's display name. */
  name: string;
  onClose: () => void;
}) {
  const [manual, setManual] = useState<string>();
  const action = useAction({ toast: 'Not uninstalled', refresh: true, leaves: true });
  const uninstall = () =>
    void action.run('uninstall', async () => {
      await client.installations.uninstall(install.id).catch((reason: unknown) => {
        setManual((reason as { hint?: string }).hint);
        throw reason;
      });
      showToast(
        `Uninstalled from ${install.account}`,
        `${install.app} no longer answers there.`,
        'success',
      );
    });

  return (
    <ConfirmDialog
      open
      title={`Uninstall ${install.app} from ${install.account}?`}
      body={
        <>
          The agent stops answering on {install.account}. Installing again works any time.
          {manual ? (
            <>
              <br />
              {name} did not uninstall it, so uninstall it{' '}
              <a class="link" href={manual} target="_blank" rel="noreferrer">
                on {name}
              </a>{' '}
              instead.
            </>
          ) : null}
        </>
      }
      confirmLabel="Uninstall"
      busy={Boolean(action.pending)}
      onConfirm={uninstall}
      onClose={onClose}
    />
  );
}

/** Uninstall from one account, asked in its dialog first. */
export function UninstallButton({
  install,
  name,
  url,
}: {
  install: InstallChoice;
  name: string;
  /** Where the install is managed on the platform; Manage there leads, with Uninstall behind its caret. */
  url?: string;
}) {
  // By id: after the refresh this button may stand for the next install.
  const [asked, setAsked] = useState<string>();

  return (
    <>
      {url ? (
        <span class="split">
          <Button variant="outline" size="sm" href={url} external>
            Manage on {name}
          </Button>
          <Menu
            button={{ variant: 'outline', size: 'sm', class: 'split-more' }}
            label={`More for ${install.account}`}
            summary={<Icon d={iDown} />}
          >
            <MenuItem icon={iX} title="Uninstall" danger onClick={() => setAsked(install.id)} />
          </Menu>
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAsked(install.id)}>
          Uninstall
        </Button>
      )}
      {asked === install.id ? (
        <UninstallDialog install={install} name={name} onClose={() => setAsked(undefined)} />
      ) : null}
    </>
  );
}

/** Drops a chat link's `name` from the address once the dialog it opened closes. */
function dropParam(name: string) {
  const url = new URL(location.href);
  url.searchParams.delete(name);
  history.replaceState(history.state, '', url);
}

/** Remove the app, asked in its dialog first; a chat's `?delete=` link opens the dialog. */
export function RemoveButton({
  app,
  name,
  asked = false,
}: {
  app: AppChoice;
  /** The platform's display name. */
  name: string;
  asked?: boolean;
}) {
  const [open, setOpen] = useState(asked);
  const close = () => {
    setOpen(false);
    dropParam('delete');
  };

  return (
    <>
      <Button variant="outline" danger size="sm" onClick={() => setOpen(true)}>
        Remove
      </Button>
      {open ? <RemoveDialog app={app} name={name} onClose={close} /> : null}
    </>
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
export function UpdateDialog({
  app,
  name,
  check,
  confirmed,
  onClose,
}: {
  app: Pick<AppChoice, 'name'>;
  /** The platform's display name. */
  name: string;
  check: AppCheck;
  /** Records that the values were entered on the platform. */
  confirmed: () => Promise<unknown>;
  onClose: () => void;
}) {
  const action = useAction({ toast: `${name} app not updated`, leaves: true });
  const busy = Boolean(action.pending);
  const current = !check.changed;
  const confirm = (event: MouseEvent) => {
    const dialog = (event.currentTarget as HTMLElement).closest('dialog')!;
    void action.run('confirm', async () => {
      await confirmed();
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

/** Brings the app up to date: Coder pushes it, or its dialog lists what to change on the platform; a chat's `?update=1` link arrives with `check` read, so the dialog opens at once. */
export function UpdateButton({
  app,
  name,
  appUpdate,
  check: asked,
}: {
  app: AppChoice;
  /** The platform's display name. */
  name: string;
  appUpdate: 'push' | 'drift' | 'confirm';
  check?: AppCheck;
}) {
  const nav = useRouter();
  const action = useAction({ toast: `${name} app not updated` });
  const [check, setCheck] = useState(asked);
  const update = () =>
    appUpdate === 'push'
      ? void action.run(
          'update',
          async () => {
            await client.apps.update(app.id);
            showToast(`${name} app updated`, `${app.name} now matches the agent.`, 'success');
          },
          { refresh: true },
        )
      : void action.run('update', async () => setCheck(await client.apps.drift(app.id)), {
          toast: `Not read from ${name}`,
        });

  return (
    <>
      <Button
        variant={app.changed ? 'primary' : 'outline'}
        size="sm"
        leftIcon={iUpload}
        loading={Boolean(action.pending)}
        onClick={update}
      >
        Update on {name}
      </Button>
      {check ? (
        <UpdateDialog
          app={app}
          name={name}
          check={check}
          confirmed={() => client.apps.update(app.id)}
          // What the check stored shows on the page.
          onClose={() => {
            setCheck(undefined);
            dropParam('update');
            nav.refresh();
          }}
        />
      ) : null}
    </>
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
    <UpdateDialog
      app={app}
      name={app.platform}
      check={check}
      confirmed={() => client.apps.update(app.id)}
      onClose={() => open(left.slice(1))}
    />
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

export type CreateOptions = {
  integration: string;
  /** The platform's display name. */
  name: string;
  createUrl: string;
  /** The form that creates the app here; without one, creation happens on the platform. */
  create?: CreateStep;
  unreachable?: boolean;
  /** Apps may be installable by any account; Create app asks first. */
  publicApps?: boolean;
  /** Apps may live under an organization; Create app asks which. */
  organizationApps?: boolean;
};

/** Creating an app on the platform: who can install it first when the platform lets you pick, then its form or the platform's own. */
function useCreate({
  integration,
  name,
  createUrl,
  create,
  unreachable,
  publicApps = false,
  organizationApps = false,
}: CreateOptions) {
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState<{ state: Record<string, string>; step: CreateStep }>();
  const [asking, setAsking] = useState(false);
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
    publicApps || organizationApps
      ? setAsking(true)
      : void begin(createState(createUrl)).catch(reason =>
          toastError('App not created', reasonText(reason)),
        );

  return {
    leaving,
    start,
    dialogs: (
      <>
        {creating ? (
          <CreateDialog
            integration={integration}
            step={creating.step}
            start={() => client.apps.create(integration, creating.state)}
            unreachable={unreachable}
            onClose={() => setCreating(undefined)}
          />
        ) : null}
        {asking ? (
          <WhereDialog
            integration={integration}
            name={name}
            publicApps={publicApps}
            organizationApps={organizationApps}
            unreachable={unreachable}
            onSubmit={(owner, isPublic) => begin(createState(createUrl, owner, isPublic))}
            onClose={() => setAsking(false)}
          />
        ) : null}
      </>
    ),
  };
}

/** Create another app on the platform, a separate one with its own name. */
export function CreateButton(options: CreateOptions) {
  const { leaving, start, dialogs } = useCreate(options);

  return (
    <>
      <Button variant="outline" size="sm" loading={leaving} onClick={start}>
        Create another {options.name} app
      </Button>
      {dialogs}
    </>
  );
}

/** A caret with no options, so a button keeps the split shape its neighbours' buttons have. */
export const NoOptions = () => (
  <Button size="sm" class="split-more" disabled aria-label="No more options">
    <Icon d={iDown} />
  </Button>
);

/** The one next step for a platform; the row menu installs again and ends at each app's page, which lists its installs. */
export function PlatformActions({
  apps,
  installed,
  split,
  reinstall,
  shared = false,
  failed,
  agent,
  ...options
}: CreateOptions & {
  /** The agent whose apps these are; the page's own agent by default. */
  agent?: string;
  apps: AppChoice[];
  installed: boolean;
  /** The app whose every install was removed on the platform. */
  reinstall?: string;
  /** The apps are this server's shared ones, installed but never created here. */
  shared?: boolean;
  /** Another row's button in the same list is a split one; Create app keeps that shape. */
  split?: boolean;
  /** The platform's last setup failed, on `app` when it was an install; `title` and `text` say how, else it was unexpected. */
  failed?: { name: string; app?: string; issues?: string; title?: string; text?: string };
}) {
  const params = useParams<'/dash/[org]/agents/[slug]/platforms'>();
  const { org } = params;
  const slug = agent ?? params.slug;
  // Off the agent's own pages, an app's page leads back to where it was opened.
  const path = usePathname();
  const back = path.startsWith(`/dash/${org}/agents/${slug}`) ? undefined : path;
  const { busy, install } = useInstall();
  const { leaving, start, dialogs } = useCreate(options);
  const { integration, name, create } = options;
  const main = apps.find(app => app.id === reinstall) ?? apps[0];
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
        <span class="split">
          <Button size="sm" loading={leaving} onClick={start}>
            {create && !create.fields.length ? create.submit : 'Create app'}
          </Button>
          {split ? <NoOptions /> : null}
        </span>
        {dialogs}
        {failure}
      </>
    );
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
          label={`More for ${name}`}
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
          {apps.map(app => (
            <MenuLink
              key={`manage ${app.id}`}
              icon={iSliders}
              href="/dash/[org]/agents/[slug]/platforms/[app]"
              params={{ org, slug, app: app.id }}
              search={back ? { back } : undefined}
            >
              {apps.length > 1 ? `Manage ${app.name}` : 'Manage app'}
            </MenuLink>
          ))}
        </Menu>
      </span>
      {dialogs}
      {failure}
    </>
  );
}
