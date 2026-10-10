'use client';

import './composer.css';

import { Fragment } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { LocalFolder, LocalFolders } from '@coder/client/types';
import { client } from '@/utils/client';
import { formatDate } from '@/utils/format';
import { iAlert, iCheck, iDown, iPlus, iRight, iSliders, iSteer, iX } from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { useRouter } from '@wular/pnext/navigation/client';
import { Loading } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Select, type Option } from '@/comps/ui/select';
import { MenuRadio } from '@/comps/ui/menu';
import { connectRepositories } from '@/app/dash/agents/editor/connect-repositories';
import {
  ENGINES,
  ENGINE_NAMES,
  defaultLabel,
  modelValue,
  splitModel,
} from '@/app/dash/settings/model-options';
import { folderName } from '@/app/dash/tasks/list/task';
import { watchTask } from '@/comps/frame/task-toasts';
import { CHOICE, PLACEHOLDER, loadComposer, savedChoice } from './composer-data';

/** What the composer runs with; the last one used comes back through the `compose` cookie. */
export interface Choice {
  repo: string;
  /** A folder on the local server's machine; unset is the server's own. */
  cwd: string;
  agent: string;
  engine: string;
  model: string;
  effort: string;
  permissions: string;
  runner: string;
}

/** The workspace's defaults, per engine, for settings left unset. */
export interface Defaults {
  engine: string;
  engines: Record<string, { model?: string; effort?: string; permissions?: string } | undefined>;
}

type Pull = { number: number; title: string; author?: string; createdAt?: string };
export type Lists = {
  agents: [string, string][];
  repos: string[];
  models: Record<string, string[]>;
  runners: Option[];
  flows: string[];
  /** Only on a local server. */
  folders?: LocalFolders;
};

const EFFORTS: Option[] = [
  ['', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const PERMISSIONS: Option[] = [
  ['', 'Default'],
  ['read-only', 'Read-only'],
  ['workspace-write', 'Write'],
  ['auto', 'Auto'],
];
const DRAFT = 'coder:draft';
const CONNECT = '+connect';
const OTHER = '+other';
const PICK = '+pick';
const CLONE = '+clone';
/** `/review 40` or `/flow release pr=12`: the command, its first word, and the rest. */
const COMMAND = /^\/(review|flow)(?:\s+(\S+))?\s*([\s\S]*)$/;

/** A select's options: its unset value, then the picked value, then the rest, so it shows its label before the list loads. */
const optionsOf = (fallback: string, value: string, values: string[]): Option[] => [
  ['', fallback],
  ...[...new Set([value, ...values])].filter(Boolean).map((each): Option => [each, each]),
];
// Named choices; a value the list lacks still shows, as itself.
const named = (fallback: string, value: string, values: Option[]): Option[] => [
  ['', fallback],
  ...(value && !values.some(([id]) => id === value) ? [[value, value] as Option] : []),
  ...values,
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

/** Segments whose unset first one names the value it resolves to. */
/** The chain.s default first, then one section per engine: its own default and its models. */
function modelSections(
  groups: Record<string, string[]>,
  defaults: Defaults,
): Array<[string, Option[]]> {
  const sections: Array<[string, Option[]]> = [
    [
      '',
      [
        [
          '',
          `Default · ${[ENGINE_NAMES[defaults.engine] ?? defaults.engine, defaults.engines[defaults.engine]?.model].filter(Boolean).join(' ')}`,
        ],
      ],
    ],
  ];
  for (const engine of ENGINES) {
    if (!groups[engine]?.length) continue;
    sections.push([
      ENGINE_NAMES[engine] ?? engine,
      [
        [modelValue(engine, ''), defaultLabel(defaults.engines[engine]?.model)],
        ...groups[engine]!.map((model): Option => [modelValue(engine, model), model]),
      ],
    ]);
  }
  return sections;
}

const resolved = (options: Option[], value?: string): Option[] => {
  const label = options.find(([key]) => key && key === value)?.[1];
  return [['', defaultLabel(label?.toLowerCase())], ...options.slice(1)];
};

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
          <div key={`h:${entry.key}`} class="pop-label" role="presentation">
            {entry.head}
          </div>
        ) : null,
        <div
          key={entry.key}
          id={`${id}-${index}`}
          role="option"
          aria-selected={selected === undefined ? index === active : entry.key === selected}
          class={index === active ? 'pop-item on' : 'pop-item'}
          onMouseDown={event => event.preventDefault()}
          onPointerMove={() => index !== active && onActive(index)}
          onClick={entry.pick}
        >
          <span class="grow">{entry.label}</span>
          {entry.hint ? <small>{entry.hint}</small> : null}
          {selected === undefined ? null : <Icon d={iCheck} />}
        </div>,
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
export function NeedsCredential({
  reason,
  back = '/dash/tasks',
}: {
  reason?: string;
  back?: string;
}) {
  return (
    <div class="notice slim" role="status">
      <Icon d={iAlert} />
      <span class="grow">{reason || 'Tasks need a model credential to run.'}</span>
      <Link
        class="btn outline sm"
        href="/dash/settings/[tab]"
        params={{ tab: 'credentials' }}
        search={{ return: back }}
      >
        Add credential
      </Link>
    </div>
  );
}

/** The dashboard's one box: type and press Enter to start a task, or `/` for reviews and flows. */
export function Composer({
  initial,
  data,
  defaults,
  missing,
  connectLabel,
  tz,
}: {
  initial: Partial<Choice>;
  data: Lists;
  defaults: Defaults;
  /** No credential can run a task yet; the page says so already. */
  missing?: boolean;
  /** The repository chip's last item, from the platform that reaches repositories. */
  connectLabel: string;
  tz: string;
}) {
  const nav = useRouter();
  const [choice, setChoice] = useState({ ...CHOICE, ...initial });
  const [lists, setLists] = useState(data);
  const [pulls, setPulls] = useState<{ repo: string; items?: Pull[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Why no credential can run it, once a start says so.
  const [needs, setNeeds] = useState<string>();
  // The model row whose effort choices are open.
  const [expanded, setExpanded] = useState<string>();
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
    box.current?.focus();
    // A restored draft waits for typing before its slash menu opens.
    setDismissed(true);
  }, []);

  // The repository's open pull requests and its own flows, once a command is being typed.
  const commanding = text.startsWith('/');
  useEffect(() => {
    const repo = choice.repo;
    if (!commanding || !repo || pulls?.repo === repo) return;
    setPulls({ repo });
    void client.pulls
      .list(repo)
      .then(items => setPulls({ repo, items }))
      .catch(reason => {
        setPulls({ repo, items: [] });
        setError(reasonText(reason));
      });
    void client.flows
      .list(repo)
      .then(flows => setLists(current => ({ ...current, flows: flows.map(flow => flow.name) })))
      .catch(() => {});
  }, [commanding, choice.repo]);

  const pick = (key: keyof Choice, value: string) => {
    if (value === OTHER) return setTyping('path');
    if (value === CLONE) return setTyping('url');
    if (value === PICK) return void pickFolder();
    if (value === CONNECT)
      return void connectRepositories('/dash/tasks').catch(reason => setError(reasonText(reason)));
    apply({ [key]: value });
    if (key === 'repo' || key === 'cwd') box.current?.focus({ preventScroll: true });
  };
  const apply = (change: Partial<Choice>) => {
    const next = { ...choice, ...change };
    setChoice(next);
    document.cookie = `compose=${encodeURIComponent(JSON.stringify(next))}; path=/; max-age=31536000; samesite=lax`;
  };

  const chose = (checked: Awaited<ReturnType<typeof client.folders.check>>) => {
    if (!checked.ok) return setError(checked.detail);
    setError('');
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
    setAt(0);
    setDismissed(false);
    field.focus();
    field.setSelectionRange(value.length, value.length);
  };

  const start = async (pr?: number) => {
    const text = box.current?.value.trim() ?? '';
    if (busy || cloning || !(text || pr)) return;
    const [, command, name = '', args = ''] = COMMAND.exec(text) ?? [];
    if (!pr && command && !(command === 'flow' ? name : /^#?\d+$/.test(name)))
      return void setDismissed(false);
    const review = pr ?? (command === 'review' ? Number(name.replace('#', '')) : undefined);
    if (review && !choice.repo) return setError('Pick a repository first.');
    const { agent, engine, model, effort, permissions, runner } = choice;
    const [repo, cwd] = lists.folders ? ['', choice.cwd] : [choice.repo, ''];
    const fields = Object.fromEntries(
      Object.entries({ repo, cwd, engine, model, effort, permissions, runner }).filter(
        ([, value]) => value,
      ),
    );
    setBusy(true);
    setError('');
    try {
      const created = review
        ? await client.review({ ...fields, repo: choice.repo, pr: review })
        : command === 'flow'
          ? await client.flows.run(name, { ...fields, agent, args: argsOf(args) })
          : await client.tasks.create({ ...fields, agent, prompt: text });
      if (!pr || command) localStorage.removeItem(DRAFT);
      watchTask(created.task.id, 'queued', text || `Review of #${review}`);
      nav.push('/dash/tasks/[id]', { params: { id: created.task.id } });
    } catch (reason) {
      setBusy(false);
      if ((reason as { status?: number }).status === 409) setNeeds(reasonText(reason));
      else setError(reasonText(reason));
    }
  };

  // The slash menu for what is typed so far: commands, then a flow, a repository or a pull request.
  const menu = ((): { label: string; entries: Entry[]; note?: string } | undefined => {
    const word = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
    if (word !== undefined)
      return {
        label: 'Commands',
        entries: [
          {
            key: 'review',
            label: '/review',
            hint: 'Review a pull request',
            pick: () => draft('/review '),
          },
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
    const number = /^\/review\s+#?(\S*)$/.exec(text)?.[1];
    if (number === undefined) return undefined;
    if (!choice.repo)
      return {
        label: 'Pick a repository',
        entries: [
          ...lists.repos
            .filter(repo => repo.includes(number))
            .map(repo => ({ key: repo, label: repo, pick: () => pick('repo', repo) })),
          { key: CONNECT, label: connectLabel, pick: () => pick('repo', CONNECT) },
        ],
      };
    if (!pulls?.items)
      return { label: `Pull requests in ${choice.repo}`, entries: [], note: 'loading' };
    return {
      label: `Pull requests in ${choice.repo}`,
      entries: [
        ...pulls.items
          .filter(
            pull =>
              String(pull.number).startsWith(number) ||
              pull.title.toLowerCase().includes(number.toLowerCase()),
          )
          // The exact number first, so `/review 39` picks #39 over #390.
          .sort((a, b) => Number(String(b.number) === number) - Number(String(a.number) === number))
          .map(pull => ({
            key: `#${pull.number}`,
            label: `#${pull.number} ${pull.title}`,
            hint: [pull.author, pull.createdAt ? formatDate(Date.parse(pull.createdAt), tz) : '']
              .filter(Boolean)
              .join(' · '),
            pick: () => void start(pull.number),
          })),
        ...(number
          ? []
          : [
              {
                key: '',
                label: choice.repo,
                hint: 'Pick another repository',
                pick: () => apply({ repo: '' }),
              },
            ]),
      ],
      note: pulls.items.length ? 'No open pull request matches.' : 'No open pull requests.',
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

  const engine = choice.engine || defaults.engine;
  const own = defaults.engines[engine] ?? {};
  const agents = lists.agents.filter(([id]) => id !== 'coder');
  // Only the settings that differ from the workspace's defaults.
  const changed = [
    choice.agent !== 'coder' && choice.agent,
    choice.engine !== defaults.engine && choice.engine,
    ...(['model', 'effort', 'permissions'] as const).map(
      key => choice[key] !== own[key] && choice[key],
    ),
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
                ...optionsOf('No repository', choice.repo, lists.repos),
                [CONNECT, connectLabel],
              ]}
              onChange={value => pick('repo', value)}
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
                    setError('');
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
            title="Model, effort, permissions and more"
          >
            <Icon d={iSliders} />
            {changed ? <span>{changed}</span> : null}
          </button>
          <button
            class="btn sm send"
            disabled={busy || !text.trim()}
            aria-busy={busy}
            aria-label={busy ? 'Starting task' : 'Start task'}
            title="Start task (Enter)"
          >
            <Icon d={iSteer} />
          </button>
        </div>
        {typing === 'url' ? (
          <small class="folder-hint">Uses this machine's git logins</small>
        ) : null}
        <ErrorText value={error} />
        <div
          id={`${id}-settings`}
          class="pop composer-settings"
          popover="auto"
          onBeforeToggle={place}
        >
          <p class="pop-label">Model</p>
          <div role="group" aria-label="Model" class="pop-radios">
            {modelSections(lists.models, defaults).map(([engine, items]) => (
              <Fragment key={engine}>
                {engine ? <p class="pop-group">{engine}</p> : null}
                {items.map(([value, label]) => {
                  const on = value === modelValue(choice.engine, choice.model);
                  const picked = splitModel(value);
                  const efforts = resolved(
                    EFFORTS,
                    defaults.engines[picked.engine || defaults.engine]?.effort,
                  );
                  const effortLabel =
                    on && choice.effort
                      ? efforts.find(([key]) => key === choice.effort)?.[1]
                      : undefined;
                  const showing = expanded === value;
                  return (
                    <Fragment key={value}>
                      <div class="pop-row">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={on}
                          class={on ? 'pop-item on' : 'pop-item'}
                          onClick={event => {
                            apply({ ...picked, effort: '' });
                            event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                          }}
                        >
                          <span class="grow">{label}</span>
                          {effortLabel ? <small>{effortLabel.toLowerCase()}</small> : null}
                          {on ? <Icon d={iCheck} /> : null}
                        </button>
                        <button
                          type="button"
                          class="pop-chev"
                          data-keep
                          aria-label={`Effort for ${label}`}
                          aria-expanded={showing}
                          onClick={() => setExpanded(showing ? undefined : value)}
                        >
                          <Icon d={iRight} />
                        </button>
                      </div>
                      {showing ? (
                        <div role="group" aria-label={`Effort for ${label}`} class="pop-sub">
                          {efforts.map(([effort, text]) => (
                            <MenuRadio
                              key={effort}
                              on={on && choice.effort === effort}
                              onPick={() => {
                                apply({ ...picked, effort });
                                document.getElementById(`${id}-settings`)?.hidePopover();
                              }}
                            >
                              {text}
                            </MenuRadio>
                          ))}
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
            <Link
              class="pop-item add-models"
              href="/dash/settings/[tab]"
              params={{ tab: 'models' }}
            >
              <Icon d={iPlus} />
              <span class="grow">Add models</span>
            </Link>
          </div>
          <p class="pop-label">Permissions</p>
          <div role="group" aria-label="Permissions">
            {resolved(PERMISSIONS, own.permissions ?? 'auto').map(([value, label]) => (
              <MenuRadio
                key={value}
                on={choice.permissions === value}
                onPick={() => apply({ permissions: value })}
              >
                {label}
              </MenuRadio>
            ))}
          </div>
          {agents.length || choice.agent !== 'coder' ? (
            <>
              <p class="pop-label">Agent</p>
              <Select
                label="Agent"
                value={choice.agent}
                options={named('coder', choice.agent, agents)}
                onChange={value => apply({ agent: value })}
              />
            </>
          ) : null}
          {lists.runners.length > 1 ? (
            <>
              <p class="pop-label">Runs on</p>
              <Select
                label="Runs on"
                options={lists.runners}
                value={choice.runner}
                onChange={value => apply({ runner: value })}
              />
            </>
          ) : null}
        </div>
        <div
          ref={slash}
          id={`${id}-slash`}
          class="pop composer-slash"
          popover="manual"
          role="listbox"
          aria-label={menu?.label ?? 'Commands'}
        >
          {menu ? (
            <>
              <div class="pop-label">{menu.label}</div>
              <Entries id={`${id}-slash`} entries={menu.entries} active={active} onActive={setAt} />
              {menu.note === 'loading' ? (
                <Loading label="Loading pull requests" inline />
              ) : menu.note && !menu.entries.length ? (
                <p class="pop-note">{menu.note}</p>
              ) : null}
            </>
          ) : null}
        </div>
      </form>
      {needs === undefined || missing ? null : <NeedsCredential reason={needs} />}
    </>
  );
}

/** The composer before it arrives: the same box and prompt, inert. */
export function LoadingComposer() {
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

  // Hovering the button already loads what the composer needs.
  const prepare = () =>
    (loading.current ??= loadComposer(client).then(setSetup, reason =>
      setError(reasonText(reason)),
    ));
  const open = () => {
    setShown(true);
    dialog.current?.showModal();
    void prepare();
  };

  return (
    <>
      <button
        type="button"
        class="btn new-task"
        onClick={open}
        onPointerEnter={prepare}
        onFocus={prepare}
      >
        <Icon d={iPlus} />
        New task
      </button>
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
          <button
            type="button"
            class="icon-btn"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            <Icon d={iX} />
          </button>
        </header>
        {!shown ? null : setup ? (
          <Composer
            {...setup}
            initial={{ ...savedChoice(document.cookie), ...(agent ? { agent } : {}) }}
            tz={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
        ) : error ? (
          <ErrorText value={error} />
        ) : (
          <LoadingComposer />
        )}
      </dialog>
    </>
  );
}
