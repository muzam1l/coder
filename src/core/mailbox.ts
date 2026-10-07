/** File mailbox between a sandboxed flow and its agent task's worker, which acts outside the sandbox. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CoderError, type CoderErrorCode } from './dispatch';
import { resolveTaskDir } from './state';
import type { Task } from './types';

/** Set in the engine's shell environment: the mailbox directory, the sandbox's one extra writable root. */
export const MAILBOX_ENV = 'CODER_MAILBOX';

const POLL_MS = 100;
const REQUEST_RE = /^([a-f0-9-]{36})\.(?:req|applying)\.json$/;

export interface MailboxKey {
  task: string;
  generation: number;
  seq: number;
}

export function mailboxId(key?: MailboxKey): string {
  if (!key) return randomUUID();
  if (
    !key.task ||
    !Number.isInteger(key.generation) ||
    key.generation < 0 ||
    !Number.isInteger(key.seq) ||
    key.seq < 0
  )
    throw new Error('Invalid command key');
  const hash = createHash('sha256')
    .update(JSON.stringify([key.task, key.generation, key.seq]))
    .digest('hex')
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export type MailboxHandlers = Record<string, (payload: any) => unknown>;

// The structured CoderError fields a caller acts on.
const ERROR_FIELDS = [
  'hint',
  'taskId',
  'payload',
  'approval',
  'result',
  'runId',
  'status',
] as const;

interface MailboxReply {
  result?: unknown;
  error?: { code: string; message: string } & Partial<
    Pick<CoderError, (typeof ERROR_FIELDS)[number]>
  >;
}

export function mailboxDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[MAILBOX_ENV] || undefined;
}

// Exclusive tmp + rename: a planted symlink is replaced, never followed.
function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** Ask the worker to act; resolves with its result or throws its error. */
export async function askWorker<T>(
  kind: string,
  payload: unknown,
  options: { dir?: string; id?: string; keepReply?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const dir = options.dir ?? mailboxDir();
  if (!dir) throw new Error('No mailbox: not inside an agent task.');
  const id = options.id ?? randomUUID();
  const reply = path.join(dir, `${id}.res.json`);
  if (!fs.existsSync(reply)) writeAtomic(path.join(dir, `${id}.req.json`), { kind, payload });
  const started = Date.now();

  for (;;) {
    if (fs.existsSync(reply)) break;
    if (options.timeoutMs && Date.now() - started >= options.timeoutMs)
      throw new Error('Worker control timed out');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  const { result, error } = JSON.parse(fs.readFileSync(reply, 'utf8')) as MailboxReply;
  if (!options.keepReply) fs.rmSync(reply, { force: true });

  if (error) {
    const { code, message, ...extra } = error;
    throw new CoderError(code as CoderErrorCode, message, extra);
  }
  return result as T;
}

/** Answer mailbox requests until the returned stop function runs. */
export function serveMailbox(dir: string, handlers: MailboxHandlers): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();

  const answer = async (file: string, id: string) => {
    let reply: MailboxReply;
    try {
      const source = path.join(dir, file);
      if (!fs.lstatSync(source).isFile()) throw new Error('mailbox request is not a regular file');
      const { kind, payload } = JSON.parse(fs.readFileSync(source, 'utf8'));
      const applying = path.join(dir, `${id}.applying.json`);
      if (!fs.existsSync(applying)) writeAtomic(applying, { kind, payload });
      const handler = Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
      if (!handler) throw new Error(`unknown mailbox request "${kind}"`);
      reply = { result: (await handler(payload ?? {})) ?? null };
    } catch (error) {
      const known = error instanceof CoderError ? error : undefined;
      reply = {
        error: {
          code: known?.code ?? 'invalid-option',
          message: error instanceof Error ? error.message : String(error),
          ...Object.fromEntries(
            ERROR_FIELDS.flatMap(key => (known?.[key] === undefined ? [] : [[key, known[key]]])),
          ),
        },
      };
    }
    try {
      writeAtomic(path.join(dir, `${id}.res.json`), reply);
      fs.rmSync(path.join(dir, `${id}.req.json`), { force: true });
      fs.rmSync(path.join(dir, `${id}.applying.json`), { force: true });
      seen.delete(id);
    } catch {
      // The mailbox is gone; the requester went with it.
    }
  };

  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      const id = REQUEST_RE.exec(file)?.[1];
      if (!id) continue;
      if (fs.existsSync(path.join(dir, `${id}.res.json`))) {
        fs.rmSync(path.join(dir, file), { force: true });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      void answer(file, id);
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}

/** The mailbox of an agent's task: the one path its sandbox may write even when read-only. */
export function agentMailboxDir(cwd: string, task: Task): string | null {
  if (!task.agentId) return null;
  return path.join(resolveTaskDir(cwd, task.id), 'mailbox');
}
