/** The command tree: one contextjsx app and its top-level shortcuts. */
import { defineApp } from 'contextjsx';

import { CODER_APP_NAME, CODER_DESCRIPTION } from '../core/runtime';
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
  name: CODER_APP_NAME,
  description: CODER_DESCRIPTION,
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
