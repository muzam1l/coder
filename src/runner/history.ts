/** A hosted task's engine conversations between turns: restored where the engine looks before a turn, uploaded after it. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { TaskHistory } from '../server/store/types';
import { codexHome } from '../core/engines/codex/sessions';
import type { DispatchOptions } from '../core/dispatch';
import { claudeProjectsDir } from '../core/engines/claude/sessions';
import { HISTORY_CONVERSATION, conversationIds, transcriptFiles } from '../core/engines/history';
import type { Task } from '../core/types';

type Engine = TaskHistory['engine'];
type Request = <T>(suffix: string, init?: RequestInit) => Promise<T>;
type Chain = Pick<Task, 'previousThreadIds' | 'pendingRollover'>;

// The upload's JSON body stays under the server's 4 MB history limit.
const MAX_UPLOAD_CHARS = 3 * 1024 * 1024;
/** Claude's project folder for every hosted task, whatever the runner's path. */
export const CLAUDE_PROJECT = 'coder';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function restoreTarget(engine: Engine, conversation: string, text: string): string {
  if (engine === 'claude')
    return path.join(
      claudeProjectsDir(),
      process.env.CLAUDE_CODE_PROJECT_DIR_NAME || CLAUDE_PROJECT,
      `${conversation}.jsonl`,
    );
  // Codex finds a rollout by the id ending its name; the date folders only order them.
  const started = new Date(JSON.parse(text.slice(0, text.indexOf('\n'))).timestamp);
  const stamp = started.toISOString().slice(0, 19).replaceAll(':', '-');
  return path.join(
    codexHome(),
    'sessions',
    ...stamp.slice(0, 10).split('-'),
    `rollout-${stamp}-${conversation}.jsonl`,
  );
}

/** Replace each secret, raw and JSON-escaped, with a marker. */
export function redactHistory(text: string, secrets: string[]): string {
  const values = secrets
    .flatMap(secret => [secret, ...(secret.startsWith('Bearer ') ? [secret.slice(7)] : [])])
    .filter(secret => secret.length >= 8)
    .flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)])
    .sort((left, right) => right.length - left.length);

  return values.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text);
}

export function taskHistory(request: Request, secrets: () => Promise<string[]>) {
  const known = new Map<string, { engine: Engine; hash: string; file: string }>();

  return {
    /** Puts every saved conversation where its engine looks; the newest is the one to resume, `restored` once its file is in place. */
    async restore(): Promise<{ resume?: DispatchOptions['resume']; restored: boolean }> {
      const saved = await request<Array<{ engine: Engine; conversation: string }>>(
        '/history',
      ).catch(error => {
        console.error('coder runner: saved history could not be listed', error);
        return [];
      });
      const newest = saved.at(-1);
      let chain: Chain | undefined;
      await Promise.all(
        saved.map(async ({ engine, conversation }) => {
          if (!HISTORY_CONVERSATION.test(conversation)) return;
          try {
            const { data, state } = await request<{ data: string; state?: Chain }>(
              `/history/${conversation}`,
            );
            if (conversation === newest!.conversation) chain = state;
            const text = gunzipSync(Buffer.from(data, 'base64')).toString('utf8');
            for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
            let [file] = await transcriptFiles({ engine }, conversation);
            if (!file) {
              file = restoreTarget(engine, conversation, text);
              await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
              await fs.writeFile(file, text, { mode: 0o600 });
            }
            known.set(conversation, { engine, hash: digest(text), file });
          } catch (error) {
            console.error(`coder runner: history ${conversation} could not be restored`, error);
          }
        }),
      );

      return {
        ...(newest
          ? { resume: { ...chain, engine: newest.engine, threadId: newest.conversation } }
          : {}),
        restored: Boolean(newest && known.has(newest.conversation)),
      };
    },

    /** Uploads every conversation the turn changed; the current one goes last, with the chain, so it resumes next. */
    async save(current?: Pick<Task, 'engine' | 'threadId'> & Chain): Promise<void> {
      const conversations = new Map([...known].map(([id, { engine }]) => [id, engine]));
      if (current?.engine === 'claude' || current?.engine === 'codex')
        for (const id of conversationIds(current)) {
          conversations.delete(id);
          conversations.set(id, current.engine);
        }
      const values = await secrets();
      for (const [conversation, engine] of conversations) {
        const cached = known.get(conversation)?.file;
        const file =
          cached &&
          (await fs.stat(cached).then(
            stat => stat.isFile(),
            () => false,
          ))
            ? cached
            : (await transcriptFiles({ engine }, conversation))[0];
        const text = file ? await fs.readFile(file, 'utf8').catch(() => '') : '';
        const active = conversation === current?.threadId;
        if (!text || (!active && digest(text) === known.get(conversation)?.hash)) continue;
        const data = gzipSync(redactHistory(text, values)).toString('base64');
        if (data.length > MAX_UPLOAD_CHARS) {
          console.error(`coder runner: history ${conversation} is too large to save`);
          continue;
        }
        const state: Chain | undefined = active
          ? JSON.parse(
              redactHistory(
                JSON.stringify({
                  previousThreadIds: current!.previousThreadIds,
                  pendingRollover: current!.pendingRollover,
                }),
                values,
              ),
            )
          : undefined;
        await request('/history', {
          method: 'POST',
          body: JSON.stringify({ engine, conversation, data, ...(state ? { state } : {}) }),
        }).then(
          () => known.set(conversation, { engine, hash: digest(text), file: file! }),
          error => console.error(`coder runner: history ${conversation} was not saved`, error),
        );
      }
    },
  };
}
