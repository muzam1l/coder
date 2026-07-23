#!/usr/bin/env node
/**
 * Coder runtime CLI entry. Task operations live under the `coder task <sub>`
 * namespace (with top-level shortcut aliases like `coder run`/`tasks`/`status`);
 * setup/config/upgrade are standalone. Routes to handlers in ./cmd, wiring in
 * help, the version flag, and the passive update notice.
 */
import process from 'node:process';

import { maybeNotifyUpdate, refreshUpdateCache } from './lib/update-check.js';
import { CLI_PATH, readVersion } from './lib/runtime.js';
import { fail } from './lib/ui.js';
import {
  COMMAND_HELP,
  HELP_ALIASES,
  renderCommandHelp,
  renderFlowGroupHelp,
  renderModelGroupHelp,
  renderTaskGroupHelp,
  renderTopHelp,
  wantsHelp,
} from './lib/help.js';
import { commandFlow } from './cmd/flow.js';
import { commandTask, commandWorker } from './cmd/task.js';
import { commandResult } from './cmd/result.js';
import { commandStream } from './cmd/stream.js';
import { commandSteer } from './cmd/steer.js';
import { commandStop } from './cmd/stop.js';
import { commandJobs } from './cmd/jobs.js';
import { commandArchive, commandArchiveSweep } from './cmd/archive.js';
import { commandDelete } from './cmd/delete.js';
import { commandApprovals, commandApprove } from './cmd/approvals.js';
import { commandConfig } from './cmd/config.js';
import { commandSetupHost } from './cmd/setup-host.js';
import { commandModel } from './cmd/model.js';
import { commandDocs } from './cmd/docs.js';
import { commandUpgrade } from './cmd/upgrade.js';
import type { CommandHandler } from './lib/types.js';

// Subcommands of `coder task <sub> ...`.
const TASK_SUBCOMMANDS: Record<string, CommandHandler> = {
  run: commandTask,
  list: commandJobs,
  stream: commandStream,
  result: commandResult,
  steer: commandSteer,
  stop: commandStop,
  archive: commandArchive,
  delete: commandDelete,
  approvals: commandApprovals,
  approve: commandApprove,
};

// `coder task <sub> ...` dispatcher. Creating a task requires the explicit
// `run` subcommand (or the `coder run` shortcut), so a first arg that is not a
// known subcommand is an error rather than silently starting a task.
async function commandTaskGroup(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(renderTaskGroupHelp());
    return;
  }
  const handler = TASK_SUBCOMMANDS[sub];
  if (!handler) {
    process.stdout.write(renderTaskGroupHelp());
    fail(`Unknown task subcommand "${sub}".`, { hint: 'Run a task: coder run "<text>"' });
  }
  if (wantsHelp(rest)) {
    process.stdout.write(renderCommandHelp(`task ${sub}`) ?? renderTaskGroupHelp());
    return;
  }
  await handler(rest);
}

const COMMANDS: Record<string, CommandHandler> = {
  task: commandTaskGroup,
  flow: commandFlow,
  // Top-level shortcut aliases for common task subcommands.
  run: commandTask,
  list: commandJobs,
  stream: commandStream,
  result: commandResult,
  // Back-compat flat aliases (still work; canonical form is `coder task <sub>`).
  steer: commandSteer,
  stop: commandStop,
  archive: commandArchive,
  delete: commandDelete,
  approvals: commandApprovals,
  approve: commandApprove,
  watch: commandStream,
  // Standalone commands.
  config: commandConfig,
  'setup-host': commandSetupHost,
  'host-setup': commandSetupHost, // alias for setup-host
  setup: commandSetupHost, // back-compat alias for setup-host
  model: commandModel,
  docs: commandDocs,
  upgrade: commandUpgrade,
  update: commandUpgrade,
  // Internal.
  _worker: commandWorker,
  _refreshUpdate: async () => refreshUpdateCache(readVersion()),
  _archiveSweep: commandArchiveSweep,
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  if (subcommand === '--version' || subcommand === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  // Top-level help: `coder`, `coder help [topic]`, `coder --help`, `coder -h`.
  if (
    subcommand === undefined ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    // `coder help task|model` -> namespace overview; `coder help <cmd>` -> its page.
    if (argv[0] === 'task' && argv[1] === undefined) {
      process.stdout.write(renderTaskGroupHelp());
      return;
    }
    if (argv[0] === 'model' && argv[1] === undefined) {
      process.stdout.write(renderModelGroupHelp());
      return;
    }
    if (argv[0] === 'flow' && argv[1] === undefined) {
      process.stdout.write(renderFlowGroupHelp());
      return;
    }
    const id = argv
      .map(token =>
        (token === 'task' || token === 'model' || token === 'flow') && argv[1]
          ? `${token} ${argv[1]}`
          : (HELP_ALIASES[token] ?? token),
      )
      .find(token => COMMAND_HELP[token]);
    process.stdout.write((id && renderCommandHelp(id)) || renderTopHelp());
    return;
  }

  // Passive, non-blocking update notice. Skip internal/refresh commands so the
  // detached refresher never re-triggers itself.
  if (
    subcommand !== '_worker' &&
    subcommand !== '_refreshUpdate' &&
    subcommand !== '_archiveSweep'
  ) {
    maybeNotifyUpdate(readVersion(), CLI_PATH);
  }

  const handler = COMMANDS[subcommand];
  if (!handler) {
    process.stdout.write(renderTopHelp());
    process.stdout.write('\n');
    fail(`Unknown command "${subcommand}".`, { hint: 'See all commands: coder --help' });
  }

  // The task group owns its own help routing (group and per-subcommand).
  if (subcommand === 'model' && wantsHelp(argv)) {
    const sub = argv.find(token => !token.startsWith('-'));
    process.stdout.write((sub && renderCommandHelp(`model ${sub}`)) || renderModelGroupHelp());
    return;
  }
  if (subcommand !== 'task' && subcommand !== 'flow' && wantsHelp(argv)) {
    const id = HELP_ALIASES[subcommand] ?? subcommand;
    process.stdout.write(renderCommandHelp(id) ?? renderTopHelp());
    return;
  }

  try {
    await handler(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // parseArgs throws "Unknown option ..." / "Missing value ..." — steer the
    // user to that command's help rather than a bare stack trace.
    if (/^(Unknown option|Missing value)/.test(message)) {
      const id = HELP_ALIASES[subcommand] ?? subcommand;
      if (COMMAND_HELP[id]) {
        fail(message, { hint: `Help: coder ${subcommand} --help` });
      }
    }
    throw error;
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
