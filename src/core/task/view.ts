/** How a task log reads, in the CLI and the dashboard; free of dependencies so the dashboard imports it. */
import type { TaskLog } from '../../client/types';
import { eventJsons } from '../../agent/event-json';

/** The final message that posts nothing. */
export const EMPTY_MESSAGE = '__EMPTY__';
/** The task log line when the agent declined to reply. */
export const SKIPPED = 'Skipped: the agent chose not to reply.';
/** What the platform gets when the agent declined a reply that was due. */
export const EMPTY_MESSAGE_NOTICE = 'The agent returned no reply.';

export interface TaskLogEntry {
  at?: string;
  message?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
}

export function addTokens(
  a: TokenUsage | null,
  b: TokenUsage | null | undefined,
): TokenUsage | null {
  if (!b) return a;
  if (!a) return { ...b };

  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

export interface TaskDisplayRow {
  seq: number;
  at: number;
  kind:
    | 'assistant'
    | 'tool'
    | 'tool-result'
    | 'approval'
    | 'status'
    | 'error'
    | 'line'
    | 'reasoning'
    | 'steer'
    | 'usage';
  title: string;
  detail?: string;
  tone?: 'muted' | 'error' | 'warning';
  sourceKind: string;
  separated: boolean;
  durationMs?: number;
  tool?: string;
  exitCode?: number;
  tokens?: TokenUsage;
  result?: { ok: boolean; exitCode?: number; durationMs: number; detail: string };
  state?: string;
}

export const isApproval = (kind: string) =>
  ['approval-escalated', 'approval-answered', 'approval-decision', 'auto-review'].includes(kind);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripCwd(text: string, cwd?: string): string {
  return cwd ? text.split(`${cwd}/`).join('').split(cwd).join('.') : text;
}

/** Decode structured runner output without treating arbitrary JSON as an event. */
export function logEntry(line: string): TaskLogEntry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const kind = 'kind' in value && typeof value.kind === 'string' ? value.kind : undefined;
      const message =
        'message' in value && typeof value.message === 'string' ? value.message : undefined;
      if (kind !== undefined || message !== undefined)
        return {
          ...value,
          kind,
          message,
          at: 'at' in value && typeof value.at === 'string' ? value.at : undefined,
        };
    }
  } catch {}
  return undefined;
}

/** One reducer per transcript, also used by the terminal renderer. */
export class LogView {
  private prevKind: string | null = null;
  private lastAssistant = '';
  private lastToolText = '';
  private openCalls: TaskDisplayRow[] = [];
  // Engine invocation ids, so concurrent calls of one tool close with their own results.
  private callIds = new WeakMap<TaskDisplayRow, string>();
  private approvals = new Map<string, TaskDisplayRow>();
  private lastUsageTotal = 0;

  constructor(
    private readonly cwd?: string,
    private readonly opts: { keepAnsi?: boolean } = {},
  ) {}

  get lastAssistantMessage(): string {
    return this.lastAssistant;
  }

  /** A result or verdict that completes an earlier call or approval returns that row again, keyed by its seq. */
  reduce(record: TaskLog): TaskDisplayRow[] {
    const entry = record.entry;
    const sourceKind = entry ? String(entry.kind ?? 'status') : 'line';
    const earlier = !entry
      ? undefined
      : sourceKind === 'tool-result'
        ? this.close(record, entry)
        : sourceKind === 'approval-answered'
          ? this.decide(record, entry)
          : undefined;
    if (earlier) {
      this.prevKind = sourceKind;
      return [earlier];
    }
    const row: TaskDisplayRow = {
      seq: record.seq,
      at: record.at,
      kind: 'status',
      title: '',
      sourceKind,
      separated: false,
      tone: 'muted',
    };
    if (!entry) {
      row.kind = record.level === 'err' ? 'error' : record.level === 'sys' ? 'status' : 'line';
      row.title = stripCwd(record.line, this.cwd);
      if (record.level === 'err') row.tone = 'error';
    } else if (sourceKind === 'usage') {
      const tokens = entry.tokens as TokenUsage | undefined;
      if (!tokens) return [];
      const seeded = this.lastUsageTotal > 0;
      const grown = tokens.total - this.lastUsageTotal;
      if (!seeded || grown < Math.max(20_000, this.lastUsageTotal * 0.2)) {
        this.lastUsageTotal = Math.max(this.lastUsageTotal, tokens.total);
        return [];
      }
      this.lastUsageTotal = tokens.total;
      row.kind = 'usage';
      row.tokens = tokens;
      // The engine's last request is the context; the turn's summed input overstates it (codex counts cached input twice over).
      const context =
        typeof entry.context === 'number' ? entry.context : tokens.input + tokens.cachedInput;
      row.title = `ctx ${tokenCount(context)} · out ${tokenCount(tokens.output)}`;
    } else if (sourceKind === 'approval-escalated') {
      const actions = Array.isArray(entry.actions) ? entry.actions.map(String) : [];
      const reason = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
      row.kind = 'approval';
      row.title = [
        'Approval needed',
        reason,
        `${actions.length} action${actions.length === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ');
      row.detail = stripCwd(
        actions.map((action, index) => `${index + 1}. ${action.replaceAll('\n', '\n   ')}`).join('\n'),
        this.cwd,
      );
      row.state = 'waiting';
      this.approvals.set(String(entry.approvalId), row);
    } else if (sourceKind === 'approval-answered') {
      row.kind = 'approval';
      row.title = 'Approval';
      Object.assign(row, settle(row, record, entry));
    } else if (sourceKind === 'approval-decision') {
      const summary = stripCwd(entry.summary ? String(entry.summary) : '', this.cwd);
      const allowed = entry.decision === 'accept';
      row.kind = 'approval';
      row.title = [allowed ? 'Allowed as approved' : 'Refused by the reviewer', summary]
        .filter(Boolean)
        .join(' · ');
      row.detail = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
      if (!allowed) row.tone = 'error';
    } else if (sourceKind === 'auto-review') {
      row.kind = 'approval';
      const risk = entry.riskLevel ? `(${String(entry.riskLevel)} risk)` : '';
      const summary = stripCwd(entry.summary ? String(entry.summary) : '', this.cwd);
      const target = summary.slice(summary.indexOf(': ') + 2);
      const shown = summary && target && this.lastToolText.includes(target) ? '' : summary;
      const method = shown ? '' : String(entry.method ?? '');
      row.title = `${['auto-review', String(entry.decision ?? ''), risk, method].filter(Boolean).join(' ')}${shown ? ` · ${shown}` : ''}`;
      row.detail = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
    } else {
      const raw = entry.message
        ? String(entry.message)
        : sourceKind === 'tool-result'
          ? '(no output)'
          : String(entry.tool || entry.kind || '');
      if (!raw && !(sourceKind === 'tool-result' && (entry.exitCode != null || entry.isError)))
        return [];
      row.title = stripCwd(raw, this.cwd);
      if (sourceKind === 'assistant') {
        row.kind = 'assistant';
        row.tone = undefined;
        this.lastAssistant = row.title;
      } else if (sourceKind === 'error' || sourceKind === 'steer') {
        row.kind = sourceKind;
        row.tone = sourceKind === 'error' ? 'error' : 'warning';
      } else if (sourceKind === 'warning') {
        row.tone = 'warning';
      } else if (sourceKind === 'reasoning') {
        row.kind = 'reasoning';
        row.durationMs = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
      } else if (sourceKind === 'tool') {
        row.kind = 'tool';
        if (entry.tool) row.tool = String(entry.tool);
        this.lastToolText = row.title;
        if (entry.callId) this.callIds.set(row, String(entry.callId));
        this.openCalls.push(row);
      } else if (sourceKind === 'tool-result') {
        row.kind = 'tool-result';
        row.title = this.output(raw);
        row.exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : undefined;
        row.tone =
          (row.exitCode !== undefined && row.exitCode !== 0) || entry.isError === true
            ? 'error'
            : 'muted';
        row.durationMs = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
        if (entry.tool) row.tool = String(entry.tool);
      }
    }
    if (this.prevKind !== null) {
      row.separated =
        ['assistant', 'error', 'steer'].includes(sourceKind) ||
        (sourceKind === 'reasoning' && this.prevKind !== 'reasoning') ||
        (sourceKind === 'tool' && ['assistant', 'reasoning'].includes(this.prevKind));
    }
    this.prevKind = sourceKind;
    return [row];
  }

  // A result closes the call with its invocation id; without one, the oldest open call of its tool, or the latest call.
  private close(record: TaskLog, entry: TaskLogEntry): TaskDisplayRow | undefined {
    const tool = entry.tool ? String(entry.tool) : undefined;
    const byId = entry.callId
      ? this.openCalls.findIndex(call => this.callIds.get(call) === String(entry.callId))
      : -1;
    const index = entry.callId
      ? byId
      : tool
        ? this.openCalls.findIndex(call => call.tool === tool)
        : this.openCalls.length - 1;
    if (index < 0) return undefined;

    const [call] = this.openCalls.splice(index, 1);
    const exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : undefined;
    const durationMs =
      typeof entry.durationMs === 'number' ? entry.durationMs : record.at - call!.at || 0;
    return {
      ...call!,
      title: entry.callMessage ? stripCwd(String(entry.callMessage), this.cwd) : call!.title,
      result: {
        ok: !exitCode && entry.isError !== true,
        exitCode,
        durationMs: Math.max(0, durationMs),
        detail: this.output(entry.message ? String(entry.message) : ''),
      },
    };
  }

  private decide(record: TaskLog, entry: TaskLogEntry): TaskDisplayRow | undefined {
    const open = this.approvals.get(String(entry.approvalId));

    return open ? settle(open, record, entry) : undefined;
  }

  private output(text: string): string {
    return stripCwd(this.opts.keepAnsi ? text : text.replace(ANSI, ''), this.cwd);
  }
}

function settle(row: TaskDisplayRow, record: TaskLog, entry: TaskLogEntry): TaskDisplayRow {
  const ok = entry.decision === 'accept';

  return {
    ...row,
    state: `${ok ? 'approved' : 'denied'} ${entry.by ? `by ${String(entry.by)}` : 'in Coder'}`,
    result: {
      ok,
      durationMs: Math.max(0, record.at - row.at || 0),
      detail: !ok && entry.reason ? String(entry.reason) : '',
    },
  };
}

function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The default task list's groups: failed first, then active, then other stopped, then completed. */
export const listRank = (status: string) =>
  status === 'failed' ? 0 : status === 'completed' ? 3 : status === 'cancelled' ? 2 : 1;

/** Whether a task waits on a person: its turn waits, or an escalation is open whatever its turn does. */
export const awaitsApproval = (
  status: string,
  approvals?: ReadonlyArray<{ response?: unknown }> | null,
) => status === 'waiting' || Boolean(approvals?.some(approval => !approval.response));

/** A row's place in the task list, which keyset cursors carry. */
export type ListKey = { rank: number; createdAt: number; id: string };

/** Ids in byte order, as Postgres `collate "C"` compares them. */
export const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The task list order: `listRank` groups, newest start first, ties broken by id. */
export const byListKey = (a: ListKey, b: ListKey) =>
  a.rank - b.rank || b.createdAt - a.createdAt || byId(b.id, a.id);

export type EventMessage = { author: string; text: string; reaction?: boolean };

/** A platform turn's messages from its `<event>` prompt; undefined for any other prompt. */
export function eventMessages(prompt?: string): EventMessage[] | undefined {
  return eventJsons(prompt)?.flatMap(json => {
    if (json.reactions)
      return json.reactions.map(({ emoji, by }) => ({
        author: by.join(', '),
        text: `reacted ${emoji}`,
        reaction: true,
      }));

    return (json.messages ?? (json.message ? [json.message] : [])).map(({ text, author }) => ({
      // A platform that knows no name repeats the raw id, which shows as nothing.
      author: [author.handle, author.name].find(name => name && name !== author.id) ?? '',
      text: text || (json.event ?? ''),
    }));
  });
}

/** A prompt as a title: a platform prompt by its event text, else its first message. */
export function promptTitle(prompt?: string, eventText?: string): string | undefined {
  const text = prompt?.trim();
  if (text && !eventMessages(text)) return text;

  return (
    eventText?.trim() ||
    eventMessages(text)
      ?.find(message => !message.reaction)
      ?.text.trim()
  );
}
