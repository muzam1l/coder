/** The command tree: one contextjsx app and its top-level shortcuts. */
import { defineApp } from 'contextjsx';

import { commandAgent } from './agent';
import { commandAuth } from './auth';
import { commandConfig } from './config';
import { commandConnection } from './connection';
import { commandCredentials } from './credentials';
import { commandDocs } from './docs';
import { commandFlow } from './flow';
import { commandMcp } from './mcp';
import { commandModel } from './model';
import { commandReview } from './review';
import { commandRunner } from './runner';
import { commandServer } from './server';
import { commandSetupHost } from './setup-host';
import { commandTaskGroup } from './task';
import { commandUpgrade } from './upgrade';

export const cli = defineApp({
  name: 'coder',
  description: 'Delegate a coding task to the best available engine and steer it while it runs.',
  namespaces: [
    commandTaskGroup,
    commandFlow,
    commandAgent,
    commandCredentials,
    commandServer,
    commandRunner,
    commandAuth,
    commandModel,
    commandConnection,
  ],
  commands: [
    commandReview,
    commandConfig,
    commandSetupHost,
    commandDocs,
    commandUpgrade,
    commandMcp,
  ],
});

/** Top-level words that stand for a longer command. */
export const SHORTCUTS: Record<string, string[]> = {
  run: ['task', 'run'],
  list: ['task', 'list'],
  result: ['task', 'result'],
  dash: ['server', 'serve'],
};
