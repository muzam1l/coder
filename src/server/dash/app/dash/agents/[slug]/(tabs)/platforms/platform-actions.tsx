'use client';

import { useEffect, useId, useRef, useState } from 'preact/hooks';

import type { CreateStart } from '@coder/client/types';
import type { CreateStep, PlatformPost } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { iDots, iPlus, iSpark, iX } from '@/comps/ui/icons';
import { reasonText } from '@/utils/format';
import { CopyLine } from '@/comps/ui/copy';
import { ErrorText, Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { toastError } from '@/comps/frame/task-toasts';

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

/** The create link's state, as the create endpoints read it. */
const createState = (createUrl: string) =>
  Object.fromEntries(new URL(createUrl, location.href).searchParams);

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
        {unreachable ? (
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
        ) : null}
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

/** The one next step for a platform, and the rarer ones in its row menu. */
export function PlatformActions({
  integration,
  apps,
  installed,
  createUrl,
  create,
  unreachable,
  owners = [],
  shared = false,
}: {
  integration: string;
  apps: Array<{ id: string; name: string }>;
  installed: boolean;
  createUrl: string;
  /** The form that creates the app here; without one, creation happens on the platform. */
  create?: CreateStep;
  unreachable?: boolean;
  /** Organizations the app could live under instead of your own account. */
  owners?: string[];
  /** The apps are this server's shared ones, installed but never created here. */
  shared?: boolean;
}) {
  const { busy, install } = useInstall();
  const [leaving, setLeaving] = useState(false);
  const [creating, setCreating] = useState<string>();
  const where = (owner = '') =>
    owner ? `${createUrl}&owner=${encodeURIComponent(owner)}` : createUrl;
  // Creation on the platform: the browser posts the platform's own form, such as GitHub's manifest.
  const createThere = (owner = '') => {
    setLeaving(true);
    void client.apps
      .create(integration, createState(where(owner)))
      .then(({ post }) => post && postTo(post))
      .catch(reason => {
        setLeaving(false);
        toastError('App not created', reasonText(reason));
      });
  };
  // A step with nothing to fill in, such as signing in through a shared client, finishes with no dialog.
  const createNow = (owner = '') => {
    setLeaving(true);
    void finishCreate(
      integration,
      () => client.apps.create(integration, createState(where(owner))),
      create!.hidden,
    ).catch(reason => {
      setLeaving(false);
      toastError('App not created', reasonText(reason));
    });
  };
  const start = (owner = '') => ({
    onClick: () =>
      !create
        ? createThere(owner)
        : create.fields.length
          ? setCreating(where(owner))
          : createNow(owner),
  });
  const dialog =
    create && creating ? (
      <CreateDialog
        integration={integration}
        step={create}
        start={() => client.apps.create(integration, createState(creating))}
        unreachable={unreachable}
        onClose={() => setCreating(undefined)}
      />
    ) : null;
  // The organization the workspace already works in is preselected; the menu holds the other places.
  if (!apps.length)
    return (
      <>
        <button
          type="button"
          class="btn sm"
          title={owners[0] ? `Creates the app in ${owners[0]}` : undefined}
          disabled={leaving}
          aria-busy={leaving}
          {...start(owners[0])}
        >
          {create && !create.fields.length ? create.submit : 'Create app'}
        </button>
        {owners.length ? (
          <Menu
            summaryClass="icon-btn"
            label={`Where the ${integration} app lives`}
            wide
            summary={<Icon d={iDots} />}
          >
            {[...owners.slice(1), ''].map(name => (
              <MenuItem
                key={name}
                icon={iSpark}
                {...start(name)}
                title={name ? `Create in ${name}` : 'Create under your account'}
                sub="The app is private to where it lives."
              />
            ))}
          </Menu>
        ) : null}
        {dialog}
      </>
    );
  return (
    <>
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
        summaryClass="icon-btn"
        label={`More for ${integration}`}
        wide
        summary={<Icon d={iDots} />}
      >
        {apps.map(app => (
          <MenuItem
            key={app.id}
            icon={iPlus}
            title={
              apps.length > 1
                ? `Install ${app.name} on another account`
                : 'Install on another account'
            }
            sub="Add this app to more repositories, another org, or another workspace."
            onClick={() => install(app.id)}
          />
        ))}
        {shared ? null : (
          <MenuItem
            icon={iSpark}
            {...start(owners[0])}
            title={`Create another ${integration} app`}
            sub="A separate app for an account this one cannot be installed on."
          />
        )}
      </Menu>
      {dialog}
    </>
  );
}
