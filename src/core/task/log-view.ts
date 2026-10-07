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
}

export const isApproval = (kind: string) =>
  kind.includes('approval') || kind === 'sidecar-decision' || kind === 'auto-review';

function stripCwd(text: string, cwd?: string): string {
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
  private lastTool: string | null = null;
  private lastToolText = '';
  private lastUsageTotal = 0;

  constructor(private readonly cwd?: string) {}

  get lastAssistantMessage(): string {
    return this.lastAssistant;
  }

  reduce(record: TaskLog): TaskDisplayRow[] {
    const entry = record.entry;
    const sourceKind = entry ? String(entry.kind ?? 'status') : 'line';
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
        this.lastTool = entry.tool ? String(entry.tool) : null;
        this.lastToolText = row.title;
      } else if (sourceKind === 'tool-result') {
        row.kind = 'tool-result';
        row.exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : undefined;
        row.tone =
          (row.exitCode !== undefined && row.exitCode !== 0) || entry.isError === true
            ? 'error'
            : 'muted';
        row.durationMs = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
        const tool = entry.tool ? String(entry.tool) : null;
        if (tool && tool !== this.lastTool) row.tool = tool;
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
}

function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
