'use client';

import './task-view.css';

import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { serverEvents } from '@coder/client';
import { LogView, type TaskDisplayRow } from '@coder/core/task/log-view';
import { client } from '@/utils/client';
import { formatDate, formatDuration, reasonText } from '@/utils/format';
import { Link } from '@wular/pnext/link';
import { useSearchParams } from '@wular/pnext/navigation/client';
import type { TaskLog, TaskRow } from '@coder/client/types';
import { iAgent, iCheck, iCopy, iDown } from '@/comps/ui/icons';
import { Badge } from '@/comps/ui/badge';
import { Card, Loading } from '@/comps/ui/card';
import { Collapse } from '@/comps/ui/collapse';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { Back, PageHead } from '@/comps/frame/page-head';
import { backFrom } from '@/comps/frame/heads';
import { markdown } from '@/app/dash/agents/agent/instructions';
import { Status } from '@/app/dash/tasks/list/status';
import { folderName, sourceLabel, taskActive, taskTitle } from '@/app/dash/tasks/list/task';
import { Approval, TaskActions, useAction } from './task-actions';
import { Activity } from './activity';
import { toastError, watchTask } from '@/comps/frame/task-toasts';

const TABS = ['Conversation', 'Activity'];

type Tab = 'conversation' | 'activity';

function messageOf(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Record<string, unknown>;
  for (const key of ['output', 'answer', 'message'])
    if (typeof record[key] === 'string') return record[key];
  return fallback;
}

/** A result's message as pretty JSON when it is JSON, else as markdown. */
type Finding = {
  file: string;
  line: number;
  severity: string;
  category?: string;
  summary: string;
  failure_scenario?: string;
};

const isFindings = (json: unknown): json is { findings: Finding[] } =>
  typeof json === 'object' &&
  json !== null &&
  Array.isArray((json as { findings?: unknown }).findings) &&
  (json as { findings: unknown[] }).findings.every(
    f => typeof f === 'object' && f !== null && 'file' in f && 'summary' in f,
  );

/** A review.s findings, one per changed line, worst first. */
function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p class="body muted">No findings.</p>;
  return (
    <ul class="findings">
      {findings.map((f, index) => (
        <li key={index} class={`finding ${f.severity}`}>
          <p class="finding-head">
            <span class="sev">{f.severity}</span>
            <span class="loc">
              {f.file}:{f.line}
            </span>
            {f.category ? <span class="cat">{f.category}</span> : null}
          </p>
          <p class="finding-sum">{f.summary}</p>
          {f.failure_scenario ? <p class="finding-why muted">{f.failure_scenario}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function ResultBody({ value }: { value: unknown }) {
  const text = messageOf(value, 'Result received.');
  let json: unknown;
  if (/^\s*[[{]/.test(text))
    try {
      json = JSON.parse(text);
    } catch {}
  if (isFindings(json)) return <Findings findings={json.findings} />;
  if (json && typeof json === 'object')
    return <pre class="body json">{JSON.stringify(json, null, 2)}</pre>;
  return <div class="body md">{markdown(text)}</div>;
}

/** Back to where the task was opened from: a `back` path, a `from` list, or Tasks. */
function TaskBack() {
  const search = useSearchParams();
  return (
    <Back
      {...backFrom(search.get('from'), { href: '/dash/tasks', params: {}, label: 'Tasks' })}
      back={search.get('back')}
    />
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied' : 'Copy task id';
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      class={copied ? 'copy copied' : 'copy'}
      aria-label={label}
      title={label}
      onClick={() => void navigator.clipboard.writeText(id).then(() => setCopied(true))}
    >
      <Icon d={copied ? iCheck : iCopy} />
    </button>
  );
}

/** The task's one-row head: back, title, status, source and agent, its actions, and a muted line with id, created time and duration. */
function TaskHead({ task, tz }: { task: TaskRow; tz: string }) {
  const live = taskActive(task);
  const source = task.task.event?.integration ?? task.task.source;
  const kind = task.task.event?.type ?? (task.task.flow !== 'default' ? task.task.flow : undefined);

  return (
    <PageHead
      back={<TaskBack />}
      title={taskTitle(task).split('\n')[0]}
      meta={
        <>
          <Status status={task.status} />
          {task.archivedAt ? <Badge>archived</Badge> : null}
        </>
      }
      lead={
        <>
          <span class="task-id">{task.task.id}</span>
          <CopyId id={task.task.id} />
          <span>{formatDate(task.createdAt, tz)}</span>
          {task.startedAt && task.finishedAt ? (
            <span>{formatDuration(task.finishedAt - task.startedAt)}</span>
          ) : null}
          <span>{kind ? `${sourceLabel(source)} ${kind}` : sourceLabel(source)}</span>
          {task.task.cwd ? <span title={task.task.cwd}>{folderName(task.task.cwd)}</span> : null}
          <Link
            class="agent-link"
            href="/dash/agents/[slug]"
            params={{ slug: task.task.agent }}
            search={{ from: `/dash/tasks/${task.task.id}` }}
          >
            <Icon d={iAgent} />
            {task.task.agent}
          </Link>
        </>
      }
      actions={<TaskActions task={task} live={live} />}
    />
  );
}

/** Display rows for the lines so far; new lines only extend them. */
function useDisplayRows(lines: TaskLog[]) {
  const view = useRef<{ log: LogView; rows: TaskDisplayRow[]; seen: number }>();
  return useMemo(() => {
    const state = (view.current ??= { log: new LogView(), rows: [], seen: 0 });
    for (const line of lines.slice(state.seen)) state.rows.push(...state.log.reduce(line));
    state.seen = lines.length;
    return [...state.rows];
  }, [lines]);
}

/** A task as a conversation with its activity; the box at the bottom steers, asks, or continues. */
export function TaskView({ initial, tz }: { initial: TaskRow; tz: string }) {
  const [task, setTask] = useState(initial);
  const [lines, setLines] = useState(initial.logs ?? []);
  const [complete, setComplete] = useState((initial.logs?.length ?? 0) < LOG_CHUNK);
  const [tab, setTab] = useState<Tab>('conversation');
  const [sent, setSent] = useState<Array<{ kind: string; text: string; turn: number }>>([]);
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(0);
  // Answers already there at open have no known question; later ones pair with this session's asks in order.
  const knownAnswers = useRef(task.answer?.length ?? 0);
  const [ask, setAsk] = useState(false);
  const [status, setStatus] = useState('');
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
  const action = useAction(task.task.id);
  const live = taskActive(task);
  const replies = task.task.flow === 'default';
  const rows = useDisplayRows(lines);
  useEffect(() => watchTask(task.task.id, task.status, taskTitle(task)), [task.status]);
  useEffect(() => {
    if (action.error) toastError('Not sent', action.error);
  }, [action.error]);

  const append = (more: TaskLog[]) => {
    const fresh = more.filter(line => line.seq > after.current);
    if (!fresh.length) return;
    after.current = fresh.at(-1)!.seq;
    setLines(value => [...value, ...fresh]);
  };

  useEffect(() => {
    if (live && replies) input.current?.focus();
  }, []);

  // Older lines a chunk at a time, then the stream follows the run.
  useEffect(() => {
    if (complete) return;
    void client.tasks
      .logs(task.task.id, after.current, LOG_CHUNK)
      .then(more => {
        append(more);
        if (more.length < LOG_CHUNK) setComplete(true);
      })
      .catch(reason => setStatus(reasonText(reason)));
  }, [complete, lines.length]);

  useEffect(() => {
    if (!complete || !live) return;
    const abort = new AbortController();
    const follow = async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await client.tasks.stream(task.task.id, after.current, abort.signal);
          if (!response.ok || !response.body) {
            setStatus('Live updates stopped.');
            return;
          }
          setStatus('');
          for await (const event of serverEvents(response.body)) {
            if (event.event === 'log') append([JSON.parse(event.data)]);
            else if (event.event === 'status')
              setTask(current => ({ ...current, ...JSON.parse(event.data) }));
            else if (event.event === 'end') return;
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        setStatus('Reconnecting.');
        await new Promise(done => setTimeout(done, 1000));
      }
    };
    void follow();
    return () => abort.abort();
  }, [complete, live]);

  const turns = task.turns ?? [
    {
      prompt: task.task.prompt ?? task.task.event?.text ?? taskTitle(task),
      result: task.result,
      error: task.error,
      finishedAt: task.finishedAt,
    },
  ];

  const send = async () => {
    const text = input.current?.value.trim();
    if (!text || sending) return;
    const kind = live ? (ask ? 'ask' : 'steer') : 'continue';
    if (kind === 'ask') {
      // A question never blocks the box: it shows at once and its answer lands under it.
      input.current!.value = '';
      setSent(value => [...value, { kind, text, turn: turns.length - 1 }]);
      setAsking(count => count + 1);
      void action.run(kind, { question: text }).then(ok => {
        setAsking(count => count - 1);
        if (ok) return setTab('conversation');
        setSent(value => value.filter(message => message.text !== text || message.kind !== kind));
      });
      return;
    }
    setSending(true);
    const ok = await action.run(kind, { text }).finally(() => setSending(false));
    if (!ok) return;
    input.current!.value = '';
    if (kind === 'continue')
      setTask(current => ({
        ...current,
        status: 'queued',
        result: undefined,
        error: undefined,
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
    else {
      setSent(value => [...value, { kind, text, turn: turns.length - 1 }]);
      setTab('activity');
    }
  };

  // The menu hands focus back to its button as it closes, so the box takes it after.
  const pickMode = (next: boolean) => {
    setAsk(next);
    setTimeout(() => input.current?.focus());
  };

  const result = task.result;
  return (
    <>
      <TaskHead task={task} tz={tz} />
      {task.fallbacks?.map((fallback, index) => (
        <p key={index} class="flash" role="status">
          {fallback.engine} was unavailable. {fallback.detail} This task is using {fallback.next}.
        </p>
      ))}
      <nav class="tabs" role="tablist" aria-label="Task">
        {TABS.map(label => {
          const key = label.toLowerCase() as Tab;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          );
        })}
      </nav>
      {status ? (
        <p class="flash err" role="status">
          {status}
        </p>
      ) : null}
      {tab === 'activity' ? (
        <Activity rows={rows} live={live} tz={tz} />
      ) : (
        <div class="convo">
          {turns.map((turn, index) => {
            const last = index === turns.length - 1;
            return (
              <Fragment key={index}>
                <div class="turn prompt">
                  <p class="who">Prompt</p>
                  <Collapse class="prose">{turn.prompt}</Collapse>
                </div>
                {last && task.approval ? <Approval task={task} /> : null}
                {last
                  ? (task.answer ?? []).slice(0, knownAnswers.current).map((answer, index) => (
                      <div key={`a${index}`} class="turn answer">
                        <p class="who">Answer</p>
                        <div class="prose">{messageOf(answer, 'Answer received.')}</div>
                      </div>
                    ))
                  : null}
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
                {turn.result ? (
                  <Card title="Result">
                    <ResultBody value={turn.result} />
                  </Card>
                ) : last && live ? (
                  <Card title="Result">
                    <div class="body waiting">
                      <Loading
                        inline
                        dots
                        label="The result appears here when the task finishes."
                      />
                    </div>
                  </Card>
                ) : null}
                {turn.error ? (
                  <Card tone="danger" title="Error">
                    <div class="body prose">{turn.error}</div>
                  </Card>
                ) : null}
              </Fragment>
            );
          })}
        </div>
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
                <button
                  type="button"
                  class="pop-item rich"
                  role="menuitemradio"
                  aria-checked={!ask}
                  onClick={() => pickMode(false)}
                >
                  <span class="grow">
                    Steer<small>Change course while it works.</small>
                  </span>
                  <Icon d={iCheck} />
                </button>
                <button
                  type="button"
                  class="pop-item rich"
                  role="menuitemradio"
                  aria-checked={ask}
                  onClick={() => pickMode(true)}
                >
                  <span class="grow">
                    Ask<small>A question that does not interrupt it.</small>
                  </span>
                  <Icon d={iCheck} />
                </button>
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
            <button class="btn sm" disabled={sending} aria-busy={sending || asking > 0}>
              Send
            </button>
          </div>
        </form>
      ) : (
        <p class="muted no-reply">This flow takes no follow-ups.</p>
      )}
    </>
  );
}

/** Lines per request when a task's log loads or follows. */
export const LOG_CHUNK = 500;
