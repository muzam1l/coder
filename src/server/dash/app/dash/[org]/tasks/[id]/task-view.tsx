'use client';

import './task-view.css';

import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useFollowEnd } from '@/utils/follow';

import { serverEvents } from '@coder/client/http';
import {
  LogView,
  type TaskDisplayRow,
  EMPTY_MESSAGE,
  EMPTY_MESSAGE_NOTICE,
  SKIPPED,
  eventMessages,
  type EventMessage,
} from '@coder/core/task/view';
import { client, usePresent } from '@/utils/client';
import { formatDate, formatDuration, reasonText } from '@/utils/format';
import { Link } from '@wular/pnext/link';
import { useSearchParams } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import type { IntegrationInfo, Me, TaskLog, TaskRow, TaskTurn } from '@coder/client/types';
import { iAgent, iClock, iDown, iFolder, iPlug, iRight, iTerminal } from '@/comps/ui/icons';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { Card, Loading } from '@/comps/ui/card';
import { Collapse } from '@/comps/ui/collapse';
import { CopyButton } from '@/comps/ui/copy';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuRadio } from '@/comps/ui/menu-items';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { Back, PageHead } from '@/comps/frame/page-head';
import { markdown } from '@/app/dash/[org]/agents/agent/instructions';
import { ReadOnlyBadge, Status } from '@/app/dash/[org]/tasks/list/status';
import {
  folderName,
  replyRequired,
  sourceLabel,
  taskActive,
  taskModel,
  taskOrigin,
  taskTitle,
  TASK_TABS,
} from '@/app/dash/[org]/tasks/list/task';
import { useAction } from '@/utils/action';
import { useZone } from '@/app/zone';
import { Approval, ApprovalEntry, DecisionTurn, TaskActions, raisedIn } from './task-actions';
import { Activity, RunPreview, runSummary } from './activity';
import { toastError, useTaskEvents, watchTask } from '@/comps/frame/task-toasts';

type Tab = 'conversation' | 'activity' | 'details';

/** A fallback's model as people read it: the model part of its spec. */
const modelOf = (spec: string) => spec.split('/')[1] ?? spec;

function messageOf(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Record<string, unknown>;
  for (const key of ['output', 'answer', 'message'])
    if (typeof record[key] === 'string') return record[key];
  return fallback;
}

/** Who made a turn and what they said: a platform turn's messages, else its prompt. */
function turnMessages(task: TaskRow, prompt: string, first: boolean): EventMessage[] {
  const { event } = task.task;

  return (
    eventMessages(prompt) ??
    (first && event?.actor && prompt === event.text
      ? [
          {
            author: event.actor.login !== event.actor.id ? (event.actor.login ?? '') : '',
            text: prompt,
          },
        ]
      : [{ author: 'Prompt', text: prompt }])
  );
}

/** Whether a log line came before the end of a turn: a hosted turn's log sequence, else its finish time. */
const within = (turn: TaskTurn, line: TaskLog) =>
  turn.logSeq !== undefined
    ? line.seq < turn.logSeq
    : turn.finishedAt === undefined || line.at <= turn.finishedAt;

/** Each turn's posts from the reply tool, in order, from the lines loaded so far; a line past every turn goes to the last. */
function turnReplies(turns: TaskTurn[], lines: TaskLog[]): string[][] {
  const replies = turns.map((): string[] => []);
  for (const line of lines) {
    const message = line.entry?.kind === 'reply' ? line.entry.message : undefined;
    if (!message) continue;
    const index = turns.findIndex(turn => within(turn, line));
    replies.at(index)!.push(message);
  }

  return replies;
}

function isEmpty(text: string) {
  const bare = text.trim().replace(/^`+|`+$/g, '');
  return bare.trim() === EMPTY_MESSAGE;
}

/** A result as the platform got it: an empty answer is the notice when a reply was due, else the skip. */
function ResultBody({ value, required }: { value: unknown; required: boolean }) {
  const text = messageOf(value, 'Result received.');
  if (isEmpty(text)) return <p class="body muted">{required ? EMPTY_MESSAGE_NOTICE : SKIPPED}</p>;
  let json: unknown;
  if (/^\s*[[{]/.test(text))
    try {
      json = JSON.parse(text);
    } catch {}
  if (json && typeof json === 'object')
    return <pre class="body json">{JSON.stringify(json, null, 2)}</pre>;
  return <div class="body md">{markdown(text)}</div>;
}

/** Back to where the task was opened from, a `back` path, or Tasks. */
function TaskBack() {
  const search = useSearchParams();
  const org = useOrg();
  return <Back href="/dash/[org]/tasks" params={{ org }} label="Tasks" back={search.get('back')} />;
}

/** The Details tab: the task's id, who started it and how it ran. */
function TaskDetails({ task, tz }: { task: TaskRow; tz: string }) {
  const org = useOrg();
  const { what } = taskOrigin(task);
  const { id, event, context, parent, cwd } = task.task;
  const rows: Array<[string, ComponentChildren]> = [
    [
      'ID',
      <span class="detail-id">
        <code>{id}</code>
        <CopyButton value={id} label="Copy ID" />
      </span>,
    ],
    [
      'Requested by',
      context?.user ? (
        <>
          {context.user.name}
          {context.user.email ? <span class="fact-dim"> {context.user.email}</span> : null}
        </>
      ) : null,
    ],
    [
      'Account',
      event?.actor?.login ? `${event.actor.login} on ${sourceLabel(event.integration)}` : null,
    ],
    ['Started from', what],
    ['Flow', task.task.flow && task.task.flow !== 'default' ? task.task.flow : null],
    ['Agent', task.task.agent],
    ['Model', taskModel(task)],
    ['Credential', task.credential],
    ['Access', task.task.access ?? 'auto'],
    ['Folder', cwd],
    [
      'Parent',
      parent ? (
        <Link class="link" href="/dash/[org]/tasks/[id]" params={{ org, id: parent }}>
          {parent}
        </Link>
      ) : null,
    ],
    ['Created', formatDate(task.createdAt, tz)],
    ['Started', task.startedAt ? formatDate(task.startedAt, tz) : null],
    ['Finished', task.finishedAt ? formatDate(task.finishedAt, tz) : null],
    ['Attempts', task.attempts > 1 ? String(task.attempts) : null],
  ];

  return (
    <Card>
      <dl class="kv task-details">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
      </dl>
    </Card>
  );
}

/** The task's one-row head: back, title, status, its actions, and a muted line with created time, what started it and who, folder, and the agent with its model. */
function TaskHead({
  task,
  tz,
  brand,
}: {
  task: TaskRow;
  tz: string;
  /** The source platform's brand art, when it has one. */
  brand?: IntegrationInfo['brand'];
}) {
  const org = useOrg();
  const live = taskActive(task);
  const model = taskModel(task);
  const source = task.task.event?.integration ?? task.task.source;
  const { what, by } = taskOrigin(task);

  const title = useMemo(() => taskTitle(task).split('\n')[0], [task.task, task.turns]);

  return (
    <PageHead
      back={<TaskBack />}
      title={title}
      meta={
        <>
          <Status status={task.status} approvals={task.approvals} />
          {task.archivedAt ? <Badge>archived</Badge> : null}
          {task.task.access === 'read-only' ? <ReadOnlyBadge /> : null}
        </>
      }
      lead={
        <>
          <span class="fact" title={`Created ${formatDate(task.createdAt, tz)}`}>
            <Icon d={iClock} />
            {formatDate(task.createdAt, tz, true)}
            {task.startedAt && task.finishedAt
              ? `, ran ${formatDuration(task.finishedAt - task.startedAt)}`
              : null}
          </span>
          <span class="fact" title={sourceLabel(source)}>
            {brand ? <BrandIcon brand={brand} /> : <Icon d={task.task.event ? iPlug : iTerminal} />}
            {by ? `${what} by ${by}` : what}
          </span>
          {task.task.cwd ? (
            <span class="fact" title={task.task.cwd}>
              <Icon d={iFolder} />
              {folderName(task.task.cwd)}
            </span>
          ) : null}
          <span class="fact">
            <Link
              class="agent-link"
              href="/dash/[org]/agents/[slug]"
              params={{ org, slug: task.task.agent }}
              search={{ back: `/dash/${org}/tasks/${task.task.id}` }}
            >
              <Icon d={iAgent} />
              {task.task.agent}
            </Link>
            {model ? (
              <span class="fact-dim" title="Engine, model and effort">
                {model}
              </span>
            ) : null}
          </span>
        </>
      }
      actions={<TaskActions task={task} live={live} />}
    />
  );
}

/** Display rows for the lines so far; new lines extend them or complete an earlier call. */
function useDisplayRows(lines: TaskLog[]) {
  const view = useRef<{ log: LogView; rows: TaskDisplayRow[]; seen: number }>();
  return useMemo(() => {
    const state = (view.current ??= { log: new LogView(), rows: [], seen: 0 });
    for (const line of lines.slice(state.seen))
      for (const row of state.log.reduce(line)) {
        if (row.seq > (state.rows.at(-1)?.seq ?? -1)) state.rows.push(row);
        else state.rows[state.rows.findLastIndex(({ seq }) => seq === row.seq)] = row;
      }
    state.seen = lines.length;
    return [...state.rows];
  }, [lines]);
}

/** A task as a conversation with its activity; the box at the bottom steers, asks, or continues. */
export function TaskView({
  initial,
  tz: serverZone,
  me,
  brand,
}: {
  initial: TaskRow;
  tz: string;
  me: Me;
  brand?: IntegrationInfo['brand'];
}) {
  const tz = useZone(serverZone);
  const [task, setTask] = useState(initial);
  const [lines, setLines] = useState(initial.logs ?? []);
  // A full first page leaves older lines for the stream to replay; turns wait for them.
  const [caughtUp, setCaughtUp] = useState((initial.logs?.length ?? 0) < LOG_PAGE);
  const [tab, setTab] = useState<Tab>('conversation');
  const [at, setAt] = useState<number | 'end'>();
  const [sent, setSent] = useState<Array<{ kind: string; text: string; turn: number }>>([]);
  const [asking, setAsking] = useState(0);
  // Answers already there at open have no known question; later ones pair with this session's asks in order.
  const knownAnswers = useRef(task.answer?.length ?? 0);
  const [ask, setAsk] = useState(false);
  const after = useRef(initial.logs?.at(-1)?.seq ?? -1);
  const input = useRef<HTMLTextAreaElement>(null);
  const reply = useRef<HTMLFormElement>(null);
  // The jump button floats above the reply box, however tall it grows.
  useEffect(() => {
    const form = reply.current;
    const page = form?.closest<HTMLElement>('.page');
    if (!form || !page) return;
    const observer = new ResizeObserver(() =>
      page.style.setProperty('--reply', `${form.offsetHeight}px`),
    );
    observer.observe(form);
    return () => observer.disconnect();
  }, [task.task.flow]);
  // A sent message takes the page to its end, which then follows the conversation while you stay there.
  const { follow } = useFollowEnd();
  const sender = useAction({ toast: 'Not sent' });
  const asker = useAction({ toast: 'Not sent' });
  const sending = Boolean(sender.pending);
  const live = taskActive(task);
  const replies = task.task.flow === 'default';
  const rows = useDisplayRows(lines);
  useEffect(() => watchTask(task.task.id, task.status, taskTitle(task)), [task.status]);

  const pending = useRef<TaskLog[]>([]);
  const append = (more: TaskLog[]) => {
    const fresh = more.filter(line => line.seq > after.current);
    if (!fresh.length) return;
    after.current = fresh.at(-1)!.seq;
    // Lines that land together render once.
    if (pending.current.push(...fresh) === fresh.length)
      setTimeout(() => {
        const batch = pending.current.splice(0);
        setLines(value => [...value, ...batch]);
      });
  };

  useEffect(() => {
    if (live && replies) input.current?.focus();
  }, []);

  const presence = usePresent();

  // Logs stream from when the task runs until the stream ends them, which waits for logs still arriving.
  const [streaming, setStreaming] = useState(live || !caughtUp);
  // Each catch-up opens a fresh stream, which says again when it has caught up.
  const [follows, setFollows] = useState(0);
  const resume = () => {
    setCaughtUp(false);
    setStreaming(true);
    setFollows(n => n + 1);
  };

  // Each turn's reads apply to it alone: a continue, here or from elsewhere, starts the next.
  const [round, setRound] = useState(0);
  const roundNow = useRef(0);
  roundNow.current = round;

  const reload = () => {
    const started = roundNow.current;
    void client.tasks
      .get(task.task.id)
      .then(({ logs: _logs, ...full }) => {
        if (roundNow.current !== started) return;
        setTask(full);
        if (taskActive(full)) setStreaming(true);
      })
      .catch(reason => toastError('Task not refreshed', reasonText(reason)));
  };

  // A running stream follows its own cursor; a stopped page streams the lines it missed.
  const catchUp = () => {
    reload();
    if (!streaming) resume();
  };

  // A new turn's prompt, from this page or elsewhere; its state comes from the events stream.
  const nextRound = () => {
    const next = ++roundNow.current;
    setRound(next);
    setStreaming(true);
    void client.tasks
      .get(task.task.id)
      .then(({ turns }) => {
        if (roundNow.current === next)
          setTask(current => (taskActive(current) ? { ...current, turns } : current));
      })
      .catch(reason => console.error('coder dashboard: task turns', reason));
  };

  // The head follows the browser's events stream; a finish brings the full task.
  useTaskEvents(
    event => {
      if (event.id !== task.task.id || event.deleted) return;
      if (live && !taskActive(event)) reload();
      // A new run, even one that finished and was continued between two events.
      const rerun = live && task.startedAt !== undefined && event.startedAt !== task.startedAt;
      if (taskActive(event) && (!live || rerun)) nextRound();
      // A turn continued and finished elsewhere while this page heard nothing of it.
      if (!live && !taskActive(event) && event.finishedAt !== task.finishedAt) {
        reload();
        resume();
      }
      setTask(current => ({
        ...current,
        status: event.status,
        approval: event.approval ?? undefined,
        approvals: event.approvals ?? undefined,
        archivedAt: event.archivedAt,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
        ...(event.result === undefined
          ? {}
          : {
              result: event.result ?? undefined,
              error: event.error ?? undefined,
              answer: event.answer ?? undefined,
            }),
      }));
    },
    // Missed events: refetch the task and catch up its logs from the cursor.
    catchUp,
  );

  // Logs poll every 2 s while the page has focus, every 5 s for a minute after it loses focus, and not while nobody is there.
  useEffect(() => {
    if (!streaming || presence === 'absent') return;
    const abort = new AbortController();
    const follow = async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await client.tasks.stream(task.task.id, after.current, abort.signal);
          if (!response.ok || !response.body) {
            toastError('Live updates stopped', 'Reload the page to see new activity.');
            return;
          }
          for await (const event of serverEvents(response.body)) {
            if (abort.signal.aborted) return;
            if (event.event === 'log') append([JSON.parse(event.data)]);
            else if (event.event === 'caught-up') setCaughtUp(true);
            else if (event.event === 'end') {
              setCaughtUp(true);
              return setStreaming(false);
            }
          }
        } catch (reason) {
          if (abort.signal.aborted) return;
          console.error('coder dashboard: task stream', reason);
        }
        await new Promise(done => setTimeout(done, presence === 'focused' ? 2000 : 5000));
      }
    };
    void follow();
    return () => abort.abort();
  }, [streaming, presence, round, follows]);

  const turns = task.turns ?? [
    {
      prompt: task.task.prompt ?? task.task.event?.text ?? taskTitle(task),
      result: task.result,
      error: task.error,
      finishedAt: task.finishedAt,
    },
  ];
  const parsed = useMemo(
    () =>
      turns.map((turn, index) => ({
        messages: turnMessages(task, turn.prompt, index === 0),
        required: replyRequired(task, turn.prompt),
      })),
    [turns, task.task],
  );
  const replied = useMemo(() => turnReplies(turns, lines), [turns, lines]);
  // Turns show once their log lines are in, so a reply never pushes what is already shown.
  const loaded = turns.findIndex(
    turn => !caughtUp && (!lines.length || within(turn, lines.at(-1)!)),
  );
  const shown = loaded < 0 ? turns : turns.slice(0, loaded);
  const answered = (task.approvals ?? []).filter(approval => approval.response);

  const send = async () => {
    const text = input.current?.value.trim();
    if (!text || sending) return;
    const kind = live ? (ask ? 'ask' : 'steer') : 'continue';
    follow();
    if (kind === 'ask') {
      // A question never blocks the box: it shows at once and its answer lands under it.
      input.current!.value = '';
      setSent(value => [...value, { kind, text, turn: turns.length - 1 }]);
      setAsking(count => count + 1);
      setTab('conversation');
      void asker
        .run(kind, () => client.tasks.ask(task.task.id, text))
        .then(ok => {
          setAsking(count => count - 1);
          if (!ok)
            setSent(value =>
              value.filter(message => message.text !== text || message.kind !== kind),
            );
        });
      return;
    }
    const ok = await sender.run(kind, () => client.tasks.steer(task.task.id, text));
    if (!ok) return;
    input.current!.value = '';
    if (kind === 'continue') {
      nextRound();
      setTask(current => ({
        ...current,
        status: 'queued',
        result: undefined,
        error: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        turns: [
          ...turns.map((turn, index) =>
            index === turns.length - 1
              ? { ...turn, finishedAt: turn.finishedAt ?? Date.now() }
              : turn,
          ),
          { prompt: text },
        ],
      }));
    } else {
      setSent(value => [...value, { kind, text, turn: turns.length - 1 }]);
      openActivity();
    }
  };

  const openActivity = (to?: number | 'end') => {
    setAt(to);
    setTab('activity');
  };
  const activityLink = (
    <Button variant="ghost" size="sm" rightIcon={iRight} onClick={() => openActivity('end')}>
      Activity
    </Button>
  );
  const run = rows.filter(row => row.at >= (task.startedAt ?? 0));
  const foot =
    !live && task.startedAt && task.finishedAt ? (
      <p class="run-foot">
        {runSummary(run, task.finishedAt - task.startedAt)}
        {activityLink}
      </p>
    ) : null;

  // The menu hands focus back to its button as it closes, so the box takes it after.
  const pickMode = (next: boolean) => {
    setAsk(next);
    setTimeout(() => input.current?.focus());
  };

  return (
    <>
      <TaskHead task={task} tz={tz} brand={brand} />
      {task.fallbacks?.map((fallback, index) => (
        <p key={index} class="flash" role="status">
          {modelOf(fallback.model)} was unavailable. {fallback.detail} This task is using{' '}
          {modelOf(fallback.next)}
          {fallback.next === fallback.model ? ' on another credential' : ''}.
        </p>
      ))}
      <nav class="tabs" role="tablist" aria-label="Task">
        {TASK_TABS.map(label => {
          const key = label.toLowerCase() as Tab;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => (key === 'activity' ? openActivity() : setTab(key))}
            >
              {label}
            </button>
          );
        })}
      </nav>
      {tab === 'activity' ? (
        <Activity rows={rows} live={live} tz={tz} at={at} />
      ) : tab === 'details' ? (
        <TaskDetails task={task} tz={tz} />
      ) : (
        <>
          <Approval task={task} me={me} />
          <div class="convo">
            {shown.map((turn, index) => {
              const last = index === turns.length - 1;
              const posts = replied[index]!;
              // A turn that posted with the reply tool and ended empty posted nothing more.
              const body =
                posts.length > 0 && isEmpty(messageOf(turn.result, '')) ? null : (
                  <ResultBody value={turn.result} required={parsed[index]!.required} />
                );
              const decision = turn.approval
                ? task.approvals?.find(approval => approval.id === turn.approval)
                : undefined;
              return (
                <Fragment key={index}>
                  {decision ? <DecisionTurn approval={decision} /> : null}
                  {(decision ? [] : parsed[index]!.messages).map((message, index) => (
                    <div key={`p${index}`} class="turn prompt">
                      {message.author ? <p class="who">{message.author}</p> : null}
                      <Collapse class="prose">{message.text}</Collapse>
                    </div>
                  ))}
                  {last
                    ? (task.answer ?? []).slice(0, knownAnswers.current).map((answer, index) => (
                        <div key={`a${index}`} class="turn answer">
                          <p class="who">Answer</p>
                          <div class="prose">{messageOf(answer, 'Answer received.')}</div>
                        </div>
                      ))
                    : null}
                  {posts.map((text, index) => (
                    <div key={`r${index}`} class="turn reply">
                      <p class="who">{task.task.agent}</p>
                      <div class="prose md">{markdown(text)}</div>
                    </div>
                  ))}
                  {sent
                    .filter(message => message.turn === index)
                    .map((message, index) => {
                      const asked =
                        message.kind === 'ask'
                          ? sent.filter(each => each.kind === 'ask').indexOf(message)
                          : -1;
                      const answer =
                        asked < 0 ? undefined : task.answer?.[knownAnswers.current + asked];
                      return (
                        <div key={index} class={asked < 0 ? 'turn you' : 'turn you qa'}>
                          <p class="who">{message.kind === 'ask' ? 'You asked' : 'You steered'}</p>
                          <div class="prose">{message.text}</div>
                          {asked < 0 ? null : (
                            <div class="answer">
                              <p class="who">Answer</p>
                              {answer === undefined ? (
                                <Loading
                                  inline
                                  dots
                                  label="Answering without interrupting the run."
                                />
                              ) : (
                                <div class="prose">{messageOf(answer, 'Answer received.')}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {answered
                    .filter(approval => raisedIn(turns, approval) === index)
                    .map(approval => (
                      <ApprovalEntry key={approval.id} approval={approval} />
                    ))}
                  {turn.result && (body || (last && foot)) ? (
                    <Card title="Result">
                      {body}
                      {last ? foot : null}
                    </Card>
                  ) : last && live ? (
                    <Card title="Result" actions={activityLink}>
                      <RunPreview rows={run} startedAt={task.startedAt} onOpen={openActivity} />
                    </Card>
                  ) : null}
                  {turn.error ? (
                    <Card tone="danger" title="Error">
                      <div class="body prose">{turn.error}</div>
                      {last && !turn.result ? foot : null}
                    </Card>
                  ) : null}
                </Fragment>
              );
            })}
            {shown.length < turns.length ? <Loading label="Loading the conversation." /> : null}
          </div>
        </>
      )}
      {replies ? (
        <form
          ref={reply}
          class="reply"
          onSubmit={event => {
            event.preventDefault();
            void send();
          }}
        >
          <div class="reply-box">
            {live ? (
              <Menu
                summary={
                  <>
                    {ask ? 'Ask' : 'Steer'}
                    <Icon d={iDown} />
                  </>
                }
                summaryClass="mode"
                label="Send as"
                align="up"
                wide
              >
                <MenuRadio
                  on={!ask}
                  onPick={() => pickMode(false)}
                  sub="Change course while it works."
                >
                  Steer
                </MenuRadio>
                <MenuRadio
                  on={ask}
                  onPick={() => pickMode(true)}
                  sub="A question that does not interrupt it."
                >
                  Ask
                </MenuRadio>
              </Menu>
            ) : null}
            <textarea
              ref={input}
              rows={1}
              aria-label="Message"
              autofocus={live}
              placeholder={
                live
                  ? ask
                    ? 'Ask about the run without interrupting it.'
                    : 'Steer the agent while it works.'
                  : 'Continue the conversation.'
              }
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
                event.preventDefault();
                void send();
              }}
            />
            <Button type="submit" size="sm" disabled={sending} aria-busy={sending || asking > 0}>
              Send
            </Button>
          </div>
        </form>
      ) : (
        <p class="muted no-reply">This flow takes no follow-ups.</p>
      )}
    </>
  );
}

/** Lines the task read carries; a full page means more wait in the log. */
const LOG_PAGE = 500;
