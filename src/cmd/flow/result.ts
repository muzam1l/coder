/** `coder flow result`: a run's record, steps and result. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import { TERMINAL_STATUSES } from '../../core/types';
import type { RunResult } from '../../flow/runs';
import { formatHints, formatJson, outStyle, paintStatus } from '../../tui/output';
import { baseOptions, tailOption } from '../../utils/args';
import { command } from '../../cli';
import {
  gateLine,
  gateRunningLine,
  paintPlain,
  printLedger,
  resultJson,
  stepSymbol,
  taskLabel,
  taskLine,
  type PendingLine,
} from './watch';

export const commandResult = command({
  name: 'flow result',
  help: {
    usage: 'coder flow result [run-id] [--tail <n|all>] [--json]',
    summary:
      "Show a flow run's status and result, with its tasks, gates, and token ledger.\n--tail <n> caps the step rows (0 for the result alone). Defaults to the most\nrecent run. To watch a run live, prefer `coder flow watch`.",
    flags: [['--tail <n|all>', 'show the last n step rows (default: all; 0 hides them)']],
    examples: [['coder flow result --tail 0', "the most recent run's result, no step rows"]],
  },
  options: { ...baseOptions, tail: tailOption },
  args: 1,
  async run({ options, args: [id] }) {
    const { runResult } = await import('../../flow/runs');

    const result = runResult(id);
    // --json reports a missing run as null.
    if (!result && !options.json) {
      throw new CoderError('flow-failed', id ? `No flow run "${id}".` : 'No flow runs yet.', {
        hint: 'Run one: coder flow run <name>',
      });
    }
    return result;
  },
  json: result => result && resultJson(result),
  print: (result, { options }) => printResult(result!, options.tail),
});

// Static replay with the whole row list in hand has exact rails. A level's
// vertical stops once it has no further rows (no trailing leg below a
// last-child sub-flow), and each group's last row closes with └─.
function paintRows(rows: PendingLine[], plain = false): string[] {
  const s = outStyle;
  if (plain) return rows.map(paintPlain);
  // continues(i, level): another row lands at exactly `level` after i, before
  // the tree pops above it. Deeper rows, or descendants, do not extend the leg.
  const continues = (i: number, level: number): boolean => {
    for (let j = i + 1; j < rows.length; j += 1) {
      const d = rows[j]!.depth;
      if (d < level) return false;
      if (d === level) return true;
    }
    return false;
  };
  return rows.map((row, i) => {
    let rail = '';
    for (let level = 0; level < row.depth; level += 1) {
      rail += continues(i, level) ? '│    ' : '     ';
    }
    rail += row.log ? '│ ' : continues(i, row.depth) ? '├─' : '└─';
    return `${s.dim(rail)} ${row.body}`;
  });
}

/** `flow result`: header, the run's step rows replayed from its events (`tail` keeps the last n), result, error, tokens and next steps. */
function printResult(result: RunResult, tail: number | 'all' = 'all'): void {
  const s = outStyle;
  // Piped output is read by a log scraper or an agent: plain rows.
  const plain = !process.stdout.isTTY;
  process.stdout.write(
    `${s.bold('Flow')} ${s.cyan(result.name)} ${s.dim(`(${result.runId})`)}. ${s.bold(paintStatus(result.status))}\n`,
  );
  // taskCount lands only on terminal writes; while running, count done/dispatched from the steps.
  const allSteps = result.steps;
  const done = allSteps.filter(st =>
    (TERMINAL_STATUSES as readonly string[]).includes(st.status),
  ).length;
  const tasksNote =
    result.status === 'running' ? `${done}/${allSteps.length} tasks` : `${result.taskCount} tasks`;
  process.stdout.write(
    `${s.dim(`started ${result.startedAt}${result.endedAt ? ` · ended ${result.endedAt}` : ''} · ${tasksNote}`)}\n`,
  );
  if (tail !== 0) {
    const names = new Map<string, { name: string; engine?: string; depth?: number }>();
    const started = new Map<string, { name: string; engine?: string; depth?: number }>();
    const startedGates = new Map<string, { cmd: string; depth: number }>();
    const rows: PendingLine[] = [];
    for (const e of result.events) {
      if (e.kind === 'task-start') {
        const entry = { name: taskLabel(e.name, e.prompt), engine: e.engine, depth: e.depth ?? 0 };
        names.set(e.taskId, entry);
        started.set(e.taskId, entry);
      } else if (e.kind === 'task-end') {
        started.delete(e.taskId);
        const known = names.get(e.taskId);
        rows.push({
          depth: known?.depth ?? 0,
          body: taskLine(
            stepSymbol(e.status, plain),
            known?.name ?? null,
            e.taskId,
            e.tokens,
            known?.engine,
          ),
        });
      } else if (e.kind === 'gate-start') {
        startedGates.set(e.gateId, { cmd: e.cmd, depth: e.depth ?? 0 });
      } else if (e.kind === 'gate') {
        if (e.gateId) startedGates.delete(e.gateId);
        rows.push({ depth: e.depth ?? 0, body: gateLine(e, plain) });
      } else if (e.kind === 'log') {
        for (const l of e.message.split('\n'))
          rows.push({ depth: e.depth ?? 0, body: s.light(l), log: true });
      } else if (e.kind === 'flow-start') {
        rows.push({ depth: e.depth - 1, body: s.bold(`flow ${e.name}`) });
      }
    }
    // The static view has no spinner, so a still-running step says so in words.
    for (const [taskId, entry] of started) {
      rows.push({
        depth: entry.depth ?? 0,
        body:
          taskLine(stepSymbol('running', plain), entry.name, taskId, null, entry.engine) +
          (plain ? '' : ` ${s.light('running')}`),
      });
    }
    for (const gate of startedGates.values()) {
      rows.push({
        depth: gate.depth,
        body:
          gateRunningLine(gate.cmd, stepSymbol('running', plain)) +
          (plain ? '' : ` ${s.light('running')}`),
      });
    }
    if (!rows.length) {
      // Pre-events runs (or a wiped stream): fall back to the step rollup.
      for (const step of tail === 'all' ? allSteps : allSteps.slice(-tail)) {
        rows.push({
          depth: 0,
          body: taskLine(
            stepSymbol(step.status, plain),
            step.name,
            step.taskId ?? '-',
            step.tokens,
          ),
        });
      }
    }
    const lines = paintRows(rows, plain);
    const shown = tail === 'all' ? lines : lines.slice(-tail);
    if (shown.length) {
      process.stdout.write(`\n${shown.join('\n')}\n`);
    }
  }
  if (result.endedAt && result.result !== undefined) {
    process.stdout.write(`\n${s.bold('Result:')}\n${formatJson(result.result)}\n`);
  }
  if (result.error) {
    process.stdout.write(`\n${s.red('error:')} ${result.error}\n`);
  }
  printLedger(result.ledger);
  const hints =
    result.status === 'running'
      ? [
          `Follow live: coder flow watch ${result.runId}`,
          `Stop it: coder flow stop ${result.runId}`,
        ]
      : result.status === 'stopped' || result.status === 'failed'
        ? [`Resume: coder flow resume ${result.runId}`]
        : [];
  if (hints.length) {
    process.stdout.write(`\n${formatHints(hints, s)}\n`);
  }
}
