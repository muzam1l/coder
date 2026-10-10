import type { TaskLog } from '../../client/types';

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
  kind.includes('approval') || kind === 'sidecar-decision' || kind === 'auto-review';

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
  private approval: TaskDisplayRow | undefined;
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
        : isApproval(sourceKind)
          ? this.decide(record, entry, sourceKind)
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
      row.title = `ctx ${tokenCount(tokens.input + tokens.cachedInput)} · out ${tokenCount(tokens.output)}`;
    } else if (
      (sourceKind === 'approval-decision' && entry.decision === 'escalate') ||
      sourceKind === 'approval-escalated'
    ) {
      const summary = stripCwd(entry.summary ? String(entry.summary) : '', this.cwd);
      const target =
        /^(?:run command: |Run command\. |Apply file changes\. |\w+: )?([\s\S]*)$/.exec(
          summary,
        )![1]!;
      const method = String(entry.method ?? '');
      const name = method && !method.includes('/') ? method : this.openCalls.at(-1)?.tool;
      const word = target.startsWith('{') ? '' : target.split(/\s+/)[0];
      const reason = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
      row.kind = 'approval';
      row.title = ['Approval', [name, word].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      row.detail = [target, reason && `Policy · ${reason}`].filter(Boolean).join('\n');
      row.state = sourceKind === 'approval-escalated' ? 'waiting' : 'escalated';
      if (sourceKind === 'approval-escalated') this.approvals.set(String(entry.approvalId), row);
      else this.approval = row;
    } else if (isApproval(sourceKind) && (entry.decision || !entry.message)) {
      row.kind = 'approval';
      const label =
        sourceKind === 'sidecar-decision'
          ? 'sidecar'
          : sourceKind === 'auto-review'
            ? 'auto-review'
            : 'approval';
      const risk = entry.riskLevel ? `(${String(entry.riskLevel)} risk)` : '';
      const summary = stripCwd(entry.summary ? String(entry.summary) : '', this.cwd);
      const target = summary.slice(summary.indexOf(': ') + 2);
      const shown = summary && target && this.lastToolText.includes(target) ? '' : summary;
      const method = shown ? '' : String(entry.method ?? '');
      row.title = `${[label, String(entry.decision ?? ''), risk, method].filter(Boolean).join(' ')}${shown ? ` · ${shown}` : ''}`;
      row.detail = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
    } else {
      const raw = entry.message ? String(entry.message) : String(entry.kind ?? '');
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
    const index =
      byId >= 0
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
      result: {
        ok: !exitCode && entry.isError !== true,
        exitCode,
        durationMs: Math.max(0, durationMs),
        detail: this.output(entry.message ? String(entry.message) : ''),
      },
    };
  }

  // Sidecar verdicts and escalations follow the policy verdict before them; answers carry the approval id.
  private decide(record: TaskLog, entry: TaskLogEntry, kind: string): TaskDisplayRow | undefined {
    const id = String(entry.approvalId ?? '');
    const accepted = entry.decision === 'accept';
    if (kind === 'sidecar-decision' && this.approval) {
      const reason = stripCwd(entry.reason ? String(entry.reason) : '', this.cwd);
      const row = {
        ...this.approval,
        detail: [this.approval.detail, reason && `Sidecar · ${reason}`].filter(Boolean).join('\n'),
      };
      if (entry.decision === 'escalate') return (this.approval = row);
      this.approval = undefined;
      return settle(row, record, `${accepted ? 'accepted' : 'denied'} by sidecar`, accepted);
    }
    if (kind === 'approval-escalated' && this.approval) {
      const row = { ...this.approval, state: 'waiting' };
      this.approval = undefined;
      this.approvals.set(id, row);
      return row;
    }
    const open = this.approvals.get(id);
    if (!open || (kind !== 'approval-answered' && kind !== 'approval-timeout')) return undefined;

    this.approvals.delete(id);
    return kind === 'approval-timeout'
      ? settle(open, record, 'timed out', false)
      : settle(open, record, `${accepted ? 'accepted' : 'denied'} by reviewer`, accepted);
  }

  private output(text: string): string {
    return stripCwd(this.opts.keepAnsi ? text : text.replace(ANSI, ''), this.cwd);
  }
}

function settle(row: TaskDisplayRow, record: TaskLog, state: string, ok: boolean): TaskDisplayRow {
  return {
    ...row,
    state,
    result: { ok, durationMs: Math.max(0, record.at - row.at || 0), detail: '' },
  };
}

function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
