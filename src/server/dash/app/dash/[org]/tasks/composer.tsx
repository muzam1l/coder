'use client';

import './composer.css';

import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { LocalFolder, LocalFolders } from '@coder/client/types';
import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { iAlert, iPlus, iRight, iSliders, iSteer, iX } from '@/comps/ui/icons';
import { useRouter, useSearchParams } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import { ChainLink } from '@/app/dash/[org]/settings/chain-hint';
import { Loading } from '@/comps/ui/card';
import { Button, IconButton } from '@/comps/ui/button';
import { reasonText } from '@/utils/format';
import { Icon } from '@/comps/ui/icon';
import { Select, type Option } from '@/comps/ui/select';
import {
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuOption,
  MenuPanel,
  MenuRadio,
  MenuRow,
} from '@/comps/ui/menu-items';
import { connectRepositories } from '@/app/dash/[org]/agents/editor/connect-repositories';
import {
  ACCESS,
  EFFORTS,
  specName,
} from '@/app/dash/[org]/settings/model-options';
import { ModelChoices, placeBeside } from '@/app/dash/[org]/settings/model-pick';
import { folderName } from '@/app/dash/[org]/tasks/list/task';
import { watchTask } from '@/comps/frame/task-toasts';
import { CHOICE, PLACEHOLDER, loadComposer, savedChoice, usableAgent } from './composer-data';
import { Notice } from '@/comps/ui/notice';
import { CredentialsLink } from '@/comps/nav/back';

/** What the composer runs with; the last one used comes back through the `compose` cookie. */
export interface Choice {
  repo: string;
  /** A folder on the local server's machine; unset is the server's own. */
  cwd: string;
  agent: string;
  /** A model name; unset runs the chain. */
  model: string;
  effort: string;
  access: string;
  runner: string;
}

/** The workspace's chain, which an unset model runs, and the built-in aliases that name its models. */
export interface Defaults {
  chain: string[];
  builtin: Record<string, string>;
}

/** A spec with `effort` in place of its own. */
export const withEffort = (spec: string, effort: string) =>
  [...spec.split('/').filter(part => !EFFORTS.some(([key]) => key === part)), effort].join('/');

export type Lists = {
  agents: [string, string][];
  /** The agent tasks run when they name none, when enabled here. */
  defaultAgent?: string;
  /** Every agent in this workspace is disabled. */
  agentsOff?: true;
  /** Read once the Repository field needs it. */
  repos?: string[];
  models: Record<string, string[]>;
  runners: Option[];
  flows: string[];
  /** Only on a local server. */
  folders?: LocalFolders;
};

const DRAFT = 'coder:draft';
const CONNECT = '+connect';
const REFRESH = '+refresh';
const OTHER = '+other';
const PICK = '+pick';
const CLONE = '+clone';
/** `/flow release pr=12`: the command, its first word, and the rest. */
const COMMAND = /^\/(flow)(?:\s+(\S+))?\s*([\s\S]*)$/;

/** A select's options: its unset value, then the picked value, then the rest, so it shows its label before the list loads. */
const optionsOf = (fallback: string, value: string, values: string[]): Option[] => [
  ['', fallback],
  ...[...new Set([value, ...values])].filter(Boolean).map((each): Option => [each, each]),
];

/** Unset runs in the server's own folder; then recent and chosen ones, then the machine's dialog or a path box, then a repository URL box. A saved folder the list lacks still shows. */
const folderOptions = (folders: LocalFolders, added: LocalFolder[], value: string): Option[] => {
  const paths = [...folders.recent, ...added].map(each => each.path);
  return [
    ['', 'No folder'],
    ...[...new Set([...paths, value])]
      .filter(path => path && path !== folders.current.path)
      .map((path): Option => [path, folderName(path)]),
    folders.picker ? [PICK, 'Choose…'] : [OTHER, 'Type a path…'],
    [CLONE, 'Repository…'],
  ];
};

/** A setting as one row naming its pick; its options open beside it, as a model's efforts do. */
function NestedPick({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: Option[];
  value: string;
  onPick: (value: string) => void;
}) {
  const flyout = `${useId()}-pick`;

  return (
    <MenuRow>
      <MenuItem
        title={options.find(([key]) => key === value)?.[1] ?? options[0]?.[1]}
        aria-label={label}
        data-keep
        popovertarget={flyout}
      />
      <button
        type="button"
        class="pop-chev"
        data-keep
        popovertarget={flyout}
        aria-label={`${label} options`}
      >
        <Icon d={iRight} />
      </button>
      <MenuPanel
        id={flyout}
        class="pop-flyout"
        popover="auto"
        role="group"
        aria-label={label}
        onBeforeToggle={placeBeside}
      >
        {options.map(([key, text]) => (
          <MenuRadio key={key} on={key === value} onPick={() => onPick(key)}>
            {text}
          </MenuRadio>
        ))}
      </MenuPanel>
    </MenuRow>
  );
}

/** Places an opening popover under its button, right-aligned to it. */
function place(event: ToggleEvent) {
  const pop = event.currentTarget as HTMLElement;
  const box = document.querySelector(`[popovertarget="${pop.id}"]`)?.getBoundingClientRect();
  if (event.newState !== 'open' || !box) return;
  const top = Math.round(box.bottom + 6);
  pop.style.top = `${top}px`;
  pop.style.right = `${Math.round(document.documentElement.clientWidth - box.right)}px`;
  // The menu scrolls inside the viewport instead of running off it.
  pop.style.maxHeight = `${Math.max(160, window.innerHeight - top - 16)}px`;
}

/** `key=value` pairs; a value that reads as JSON keeps its type, a bare key is true. */
function argsOf(text: string): Record<string, unknown> {
  return Object.fromEntries(
    text
      .split(/\s+/)
      .filter(Boolean)
      .map(pair => {
        const at = pair.indexOf('=');
        const raw = at < 0 ? 'true' : pair.slice(at + 1);
        try {
          return [at < 0 ? pair : pair.slice(0, at), JSON.parse(raw)];
        } catch {
          return [pair.slice(0, at), raw];
        }
      }),
  );
}

/** One row of a picker list; `head` starts a group. */
type Entry = { key: string; label: string; hint?: string; head?: string; pick: () => void };

/** Rows under a combobox; the field keeps focus, so the mouse never takes it. */
function Entries({
  id,
  entries,
  active,
  selected,
  onActive,
}: {
  id: string;
  entries: Entry[];
  active: number;
  selected?: string;
  onActive: (index: number) => void;
}) {
  return (
    <>
      {entries.flatMap((entry, index) => [
        entry.head ? (
          <MenuLabel key={`h:${entry.key}`} role="presentation">
            {entry.head}
          </MenuLabel>
        ) : null,
        <MenuOption
          key={entry.key}
          id={`${id}-${index}`}
          active={index === active}
          selected={selected === undefined ? index === active : entry.key === selected}
          check={selected !== undefined}
          end={entry.hint ? <small>{entry.hint}</small> : null}
          onMouseDown={event => event.preventDefault()}
          onPointerMove={() => index !== active && onActive(index)}
          onClick={entry.pick}
        >
          {entry.label}
        </MenuOption>,
      ])}
    </>
  );
}

/** Arrows move through `count` rows and wrap; returns whether the key was one of them. */
const stepped = (
  event: KeyboardEvent,
  at: number,
  count: number,
  move: (index: number) => void,
) => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step || !count) return false;
  event.preventDefault();
  move((at + step + count) % count);
  return true;
};

/** A credential link that comes back here with the draft kept. */
export function NeedsCredential({ reason, label }: { reason?: ComponentChildren; label?: string }) {
  const org = useOrg();

  return (
    <Notice tone="warning" slim>
      <Icon d={iAlert} />
      <span class="grow">
        {reason ?? (
          <>
            No credential runs the <ChainLink org={org} />.
          </>
        )}
      </span>
      <CredentialsLink variant="outline" size="sm" label={label}>
        Add credential
      </CredentialsLink>
    </Notice>
  );
}

/** The dashboard's one box: type and press Enter to start a task, or `/` for flows. */
function Composer({
  initial,
  data,
  defaults,
  missing,
  connectLabel,
}: {
  initial: Partial<Choice>;
  data: Lists;
  defaults: Defaults;
  /** No credential can run a task yet; the page says so already. */
  missing?: boolean;
  /** The repository chip's last item, from the platform that reaches repositories. */
  connectLabel: string;
}) {
  const nav = useRouter();
  const org = useOrg();
  const [choice, setChoice] = useState(() => usableAgent({ ...CHOICE, ...initial }, data));
  const [lists, setLists] = useState(data);
  const flowsRepo = useRef<string>();
  const [busy, setBusy] = useState(false);
  // Why no credential can run it, once a start says so.
  const [needs, setNeeds] = useState<string>();
  // The model row whose effort choices are open.
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [at, setAt] = useState(0);
  // Folders checked this session; `typing` swaps the Folder select for a path or repository URL box.
  const [added, setAdded] = useState<LocalFolder[]>([]);
  const [typing, setTyping] = useState<'' | 'path' | 'url'>('');
  const [cloning, setCloning] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const slash = useRef<HTMLDivElement>(null);
  const path = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => void (typing && path.current?.focus()), [typing]);

  useEffect(() => {
    const draft = localStorage.getItem(DRAFT);
    if (draft && box.current && !box.current.value) box.current.value = draft;
    setText(box.current?.value ?? '');
    prefetch(box.current?.value ?? '');
    box.current?.focus();
    // A restored draft waits for typing before its slash menu opens.
    setDismissed(true);
  }, []);

  // Once a command is typed, read the repository's own flows.
  const prefetch = (value: string, repo = choice.repo) => {
    if (!value.startsWith('/') || !repo || flowsRepo.current === repo) return;
    flowsRepo.current = repo;
    void client.flows
      .list(repo)
      .then(flows => setLists(current => ({ ...current, flows: flows.map(flow => flow.name) })))
      .catch(reason => console.error('coder dashboard: flows', reason));
  };

  const reposRead = useRef(Boolean(data.repos));
  const readRepos = () => {
    if (reposRead.current) return;
    reposRead.current = true;
    void client.repositories
      .list()
      .catch(reason => {
        console.error('coder dashboard: repositories', reason);
        return [];
      })
      .then(rows => setLists(current => ({ ...current, repos: rows.map(row => row.repo) })));
  };
  // Repositories the saved list misses, such as ones created since the platform was connected.
  const repos = useAction();
  const refreshing = Boolean(repos.pending);
  const refreshRepos = () => {
    reposRead.current = true;
    void repos.run('refresh', async () => {
      const rows = await client.repositories.refresh();
      setLists(current => ({ ...current, repos: rows.map(row => row.repo) }));
    });
  };

  const pick = (key: keyof Choice, value: string) => {
    if (value === OTHER) return setTyping('path');
    if (value === CLONE) return setTyping('url');
    if (value === PICK) return void pickFolder();
    if (value === REFRESH) return refreshing ? undefined : refreshRepos();
    if (value === CONNECT)
      return void connectRepositories(`/dash/${org}/tasks`).catch(toastFailure);
    apply({ [key]: value });
    if (key === 'repo' || key === 'cwd') box.current?.focus({ preventScroll: true });
  };
  const apply = (change: Partial<Choice>) => {
    const next = { ...choice, ...change };
    setChoice(next);
    prefetch(text, next.repo);
    document.cookie = `compose=${encodeURIComponent(JSON.stringify(next))}; path=/; max-age=31536000; samesite=lax`;
  };

  const chose = (checked: Awaited<ReturnType<typeof client.folders.check>>) => {
    if (!checked.ok) return toastFailure(checked.detail);
    setTyping('');
    setAdded(current => [
      ...current.filter(each => each.path !== checked.folder.path),
      checked.folder,
    ]);
    pick('cwd', checked.folder.path === lists.folders?.current.path ? '' : checked.folder.path);
  };
  const checkFolder = async (path: string) => {
    if (!path.trim()) return;
    chose(
      await client.folders
        .check(path.trim())
        .catch(reason => ({ ok: false as const, detail: reasonText(reason) })),
    );
  };
  // The dialog opens on the server's machine; the cursor waits for it, and closing it changes nothing here.
  const pickFolder = async () => {
    document.body.style.cursor = 'progress';
    const picked = await client.folders
      .pick()
      .catch(reason => ({ ok: false as const, detail: reasonText(reason) }));
    document.body.style.cursor = '';
    if (picked.ok || picked.detail) chose(picked);
  };
  const cloneFolder = async (url: string) => {
    if (!url.trim()) return;
    setCloning(true);
    document.body.style.cursor = 'progress';
    const cloned = await client.folders
      .clone(url.trim())
      .catch(reason => ({ ok: false as const, detail: reasonText(reason) }));
    document.body.style.cursor = '';
    setCloning(false);
    chose(cloned);
  };

  const draft = (value: string) => {
    const field = box.current!;
    field.value = value;
    localStorage.setItem(DRAFT, value);
    setText(value);
    prefetch(value);
    setAt(0);
    setDismissed(false);
    field.focus();
    field.setSelectionRange(value.length, value.length);
  };

  const start = async () => {
    const text = box.current?.value.trim() ?? '';
    if (busy || cloning || lists.agentsOff || !text) return;
    const [, command, name = '', args = ''] = COMMAND.exec(text) ?? [];
    if (command && !name) return void setDismissed(false);
    const { agent, model, effort, access, runner } = choice;
    const [repo, cwd] = lists.folders ? ['', choice.cwd] : [choice.repo, ''];
    // An effort on the Default row goes on the chain's first model; the rest still follow.
    const first = model || (effort ? defaults.chain[0] : '');
    const fields = Object.fromEntries(
      Object.entries({
        repo,
        cwd,
        model: first && effort ? withEffort(first, effort) : first,
        access: access === 'auto' ? '' : access,
        runner,
      }).filter(([, value]) => value),
    );
    setBusy(true);
    try {
      const created =
        command === 'flow'
          ? await client.flows.run(name, { ...fields, agent, args: argsOf(args) })
          : await client.tasks.create({ ...fields, agent, prompt: text });
      localStorage.removeItem(DRAFT);
      watchTask(created.task.id, 'queued', text);
      nav.push('/dash/[org]/tasks/[id]', { params: { org, id: created.task.id } });
    } catch (reason) {
      setBusy(false);
      if ((reason as { status?: number }).status === 409) setNeeds(reasonText(reason));
      else toastFailure(reason);
    }
  };

  // The slash menu for what is typed so far: commands, then a flow.
  const menu = ((): { label: string; entries: Entry[]; note?: string } | undefined => {
    const word = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
    if (word !== undefined)
      return {
        label: 'Commands',
        entries: [
          ...lists.flows.map(flow => ({
            key: `flow ${flow}`,
            label: `/flow ${flow}`,
            hint: `Run the ${flow} flow`,
            pick: () => draft(`/flow ${flow} `),
          })),
        ].filter(entry => entry.key.includes(word)),
        note: 'No command matches.',
      };
    const flow = /^\/flow\s+(\S*)$/.exec(text)?.[1];
    if (flow !== undefined)
      return {
        label: 'Flows',
        entries: lists.flows
          .filter(name => name.includes(flow))
          .map(name => ({
            key: name,
            label: name,
            hint: `Run the ${name} flow`,
            pick: () => (name === flow ? void start() : draft(`/flow ${name} `)),
          })),
        note: 'No flow matches.',
      };
  })();
  const open = Boolean(menu && !dismissed);
  const active = menu ? Math.min(at, Math.max(0, menu.entries.length - 1)) : 0;

  // The slash menu hangs under the box in the top layer, so a dialog never clips it.
  useLayoutEffect(() => {
    const pop = slash.current;
    if (!pop) return;
    if (!open) return void (pop.matches(':popover-open') && pop.hidePopover());
    const position = () => {
      const rect = form.current!.getBoundingClientRect();
      pop.style.top = `${Math.round(rect.bottom + 6)}px`;
      pop.style.left = `${Math.round(rect.left)}px`;
      pop.style.width = `${Math.round(Math.min(rect.width, 460))}px`;
    };
    position();
    if (!pop.matches(':popover-open')) pop.showPopover();
    addEventListener('scroll', position, true);
    addEventListener('resize', position);
    return () => {
      removeEventListener('scroll', position, true);
      removeEventListener('resize', position);
    };
  }, [open, text]);

  const head = defaults.chain[0] ?? '';
  const agents: Option[] = lists.agents.some(([id]) => id === choice.agent)
    ? lists.agents
    : [...lists.agents, [choice.agent, choice.agent]];
  // What a task gets: the model, effort and access, the workspace's defaults dimmer.
  const picks = (
    [
      [choice.model || specName(head, defaults.builtin), Boolean(choice.model)],
      [choice.effort, Boolean(choice.effort)],
      [choice.access, choice.access !== 'auto'],
    ] as const
  ).filter(([text]) => text);
  // The agent and runner only when they differ from the workspace's defaults.
  const changed = [
    choice.agent !== lists.defaultAgent && choice.agent,
    choice.runner && (lists.runners.find(([id]) => id === choice.runner)?.[1] ?? choice.runner),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <form
        ref={form}
        class="composer"
        onSubmit={event => {
          event.preventDefault();
          void start();
        }}
      >
        <textarea
          ref={box}
          name="prompt"
          rows={1}
          role="combobox"
          aria-label="What should the agent do?"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-slash`}
          aria-activedescendant={open && menu?.entries.length ? `${id}-slash-${active}` : undefined}
          placeholder={PLACEHOLDER}
          autofocus
          onFocus={() => setDismissed(false)}
          onBlur={() => setDismissed(true)}
          onInput={event => {
            const value = event.currentTarget.value;
            localStorage.setItem(DRAFT, value);
            setText(value);
            prefetch(value);
            setAt(0);
            setDismissed(false);
          }}
          onKeyDown={event => {
            if (event.isComposing) return;
            if (open && menu) {
              if (stepped(event, active, menu.entries.length, setAt)) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                return setDismissed(true);
              }
              if (
                menu.entries.length &&
                ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab')
              ) {
                event.preventDefault();
                return menu.entries[active]!.pick();
              }
            }
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            void start();
          }}
        />
        <div class="composer-line">
          {!lists.folders ? (
            <Select
              label="Repository"
              value={choice.repo}
              options={[
                ...optionsOf('No repository', choice.repo, lists.repos ?? []),
                [REFRESH, refreshing ? 'Refreshing repositories…' : 'Refresh repositories'],
                [CONNECT, connectLabel],
              ]}
              onChange={value => pick('repo', value)}
              onFocus={readRepos}
            />
          ) : typing ? (
            <>
              <input
                class="folder-path"
                aria-label={typing === 'url' ? 'Repository URL' : 'Folder path'}
                ref={path}
                placeholder={
                  typing === 'url' ? 'https://github.com/owner/repo' : 'Absolute path or ~/…'
                }
                readOnly={cloning}
                aria-busy={cloning}
                onKeyDown={event => {
                  if (cloning) return event.preventDefault();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    return setTyping('');
                  }
                  if (event.key !== 'Enter' || event.isComposing) return;
                  event.preventDefault();
                  void (typing === 'url' ? cloneFolder : checkFolder)(event.currentTarget.value);
                }}
                onBlur={event => !cloning && !event.currentTarget.value.trim() && setTyping('')}
              />
              {cloning ? <span class="folder-busy">Cloning…</span> : null}
            </>
          ) : (
            <span class="folder" title={choice.cwd || lists.folders.current.path}>
              <Select
                label="Folder"
                value={choice.cwd}
                options={folderOptions(lists.folders, added, choice.cwd)}
                subs={Object.fromEntries(
                  folderOptions(lists.folders, added, choice.cwd).flatMap(([path]) =>
                    path && path !== OTHER && path !== PICK && path !== CLONE
                      ? [[path, added.find(each => each.path === path)?.url ?? path]]
                      : [],
                  ),
                )}
                onChange={value => pick('cwd', value)}
              />
            </span>
          )}
          <button
            type="button"
            class="quiet"
            popovertarget={`${id}-settings`}
            aria-label="Run options"
            title="Model, effort, access and more"
          >
            <Icon d={iSliders} />
            <span class="run-picks">
              {picks.map(([text, picked], index) => (
                <span key={index} class={picked ? undefined : 'dim'}>
                  {index ? ` · ${text}` : text}
                </span>
              ))}
            </span>
            {changed ? <span>{changed}</span> : null}
          </button>
          <Button
            type="submit"
            size="sm"
            class="send"
            leftIcon={iSteer}
            disabled={!text.trim() || lists.agentsOff}
            loading={busy}
            aria-label={busy ? 'Starting task' : 'Start task'}
            title="Start task (Enter)"
          />
        </div>
        {lists.agentsOff ? (
          <small class="folder-hint">
            Every agent here is disabled. Enable one in its settings to start tasks.
          </small>
        ) : null}
        {typing === 'url' ? (
          <small class="folder-hint">Uses this machine's git logins</small>
        ) : null}
        <MenuPanel
          id={`${id}-settings`}
          class="composer-settings"
          popover="auto"
          onBeforeToggle={place}
        >
          <MenuLabel>Model</MenuLabel>
          <ModelChoices
            groups={lists.models}
            first={{
              label: 'Default chain',
              efforts: true,
            }}
            model={choice.model}
            effort={choice.effort}
            onPick={(model, effort) => {
              apply({ model, effort });
              document.getElementById(`${id}-settings`)?.hidePopover();
            }}
          />
          <MenuLabel>Access</MenuLabel>
          <div role="group" aria-label="Access">
            {ACCESS.map(([value, label]) => (
              <MenuRadio
                key={value}
                on={choice.access === value}
                onPick={() => apply({ access: value })}
              >
                {label}
              </MenuRadio>
            ))}
          </div>
          {agents.length > 1 ? (
            <>
              <MenuLabel>Agent</MenuLabel>
              <NestedPick
                label="Agent"
                options={agents}
                value={choice.agent}
                onPick={value => apply({ agent: value })}
              />
            </>
          ) : null}
          {lists.runners.length > 1 ? (
            <>
              <MenuLabel>Runs on</MenuLabel>
              <NestedPick
                label="Runs on"
                options={lists.runners}
                value={choice.runner}
                onPick={value => apply({ runner: value })}
              />
            </>
          ) : null}
        </MenuPanel>
        <MenuPanel
          panelRef={slash}
          id={`${id}-slash`}
          class="composer-slash"
          popover="manual"
          role="listbox"
          aria-label={menu?.label ?? 'Commands'}
        >
          {menu ? (
            <>
              <MenuLabel>{menu.label}</MenuLabel>
              <Entries id={`${id}-slash`} entries={menu.entries} active={active} onActive={setAt} />
              {menu.note === 'loading' ? (
                <Loading label="Loading pull requests" inline />
              ) : menu.note && !menu.entries.length ? (
                <MenuNote>{menu.note}</MenuNote>
              ) : null}
            </>
          ) : null}
        </MenuPanel>
      </form>
      {needs === undefined || missing ? null : <NeedsCredential reason={needs} />}
    </>
  );
}

/** The composer before it arrives: the same box and prompt, inert. */
function LoadingComposer() {
  return (
    <div class="composer" aria-hidden="true">
      <textarea rows={1} disabled tabIndex={-1} placeholder={PLACEHOLDER} />
      <div class="composer-line" />
    </div>
  );
}

/** Opens the composer in a dialog, with `agent` picked when given; starting a task opens it. */
export function NewTaskButton({ agent }: { agent?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [setup, setSetup] = useState<Awaited<ReturnType<typeof loadComposer>>>();
  const [error, setError] = useState('');
  const [shown, setShown] = useState(false);

  const loading = useRef<Promise<unknown>>();

  const open = () => {
    setShown(true);
    dialog.current?.showModal();
    loading.current ??= loadComposer(client).then(setSetup, reason => setError(reasonText(reason)));
  };

  // The Create menu's `?new` link opens the composer, then drops the param.
  const asked = useSearchParams().has('new');
  useEffect(() => {
    if (!asked) return;
    const url = new URL(location.href);
    url.searchParams.delete('new');
    history.replaceState(history.state, '', url);
    open();
  }, [asked]);

  return (
    <>
      <Button class="new-task" leftIcon={iPlus} onClick={open}>
        New task
      </Button>
      <dialog
        ref={dialog}
        class="compose-dialog"
        aria-label={agent ? `New task for ${agent}` : 'New task'}
        onClose={() => setShown(false)}
        onClick={event => event.target === event.currentTarget && dialog.current?.close()}
      >
        <header>
          <h2>New task</h2>
          {agent ? <span class="sub">{agent}</span> : null}
          <IconButton icon={iX} label="Close" onClick={() => dialog.current?.close()} />
        </header>
        {!shown ? null : setup ? (
          <Composer
            {...setup}
            initial={{ ...savedChoice(document.cookie), ...(agent ? { agent } : {}) }}
          />
        ) : error ? (
          <p class="flash err" role="alert">
            {error}
          </p>
        ) : (
          <LoadingComposer />
        )}
      </dialog>
    </>
  );
}
