/** A task's engine conversations: its runner uploads each after a turn and downloads them before the next. */
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { HISTORY_CONVERSATION } from '../../core/engines/history';
import { type Params } from '../routes/match';
import { json } from '../routes/http';
import { type TaskHistory } from '../store/types';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { type CallbackContext } from './callbacks';
import { taskLogSecrets } from './context';

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const unzip = promisify(gunzip);
const zip = promisify(gzip);

/** The task's conversations, oldest first; the last one is the one to resume. */
export async function listHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  if (ctx.store.listHistory) return json(await ctx.store.listHistory(params.id!));
  const rows = await ctx.store.list('history', { prefix: `${params.id}:` });

  return json(
    rows
      .map(({ value: { engine, conversation, savedAt } }) => ({ engine, conversation, savedAt }))
      .sort((left, right) => left.savedAt - right.savedAt),
  );
}

/** One conversation's file, gzipped and base64-encoded, with the chain saved beside it. */
export async function readHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  const row = await ctx.store.get('history', `${params.id}:${params.conversation}`);
  if (!row) return json({ error: 'No saved history' }, 404);

  try {
    return json({
      engine: row.engine,
      conversation: row.conversation,
      data: decryptSecret<string>(ctx.config, row.data),
      ...(row.state ? { state: decryptSecret(ctx.config, row.state) } : {}),
    });
  } catch (error) {
    console.error(
      `coder server: history ${params.id}/${params.conversation} could not be decrypted`,
      error,
    );
    return json({ error: 'The saved history cannot be read' }, 422);
  }
}

export async function saveHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    (Partial<Omit<TaskHistory, 'state'>> & { state?: unknown }) | undefined;
  if (
    (body?.engine !== 'claude' && body?.engine !== 'codex') ||
    typeof body.conversation !== 'string' ||
    !HISTORY_CONVERSATION.test(body.conversation) ||
    typeof body.data !== 'string' ||
    (body.state !== undefined &&
      (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)))
  )
    return json({ error: 'Invalid history' }, 400);
  let text: string;
  try {
    text = (
      await unzip(Buffer.from(body.data, 'base64'), {
        maxOutputLength: MAX_HISTORY_BYTES,
      })
    ).toString('utf8');
  } catch {
    return json({ error: 'Invalid history' }, 400);
  }

  const secrets = (await taskLogSecrets(ctx, ctx.callbackTask!)).sort(
    (left, right) => right.length - left.length,
  );
  const redact = (value: string) =>
    secrets.reduce((redacted, secret) => redacted.replaceAll(secret, '[REDACTED]'), value);
  await ctx.store.put('history', `${params.id}:${body.conversation}`, {
    engine: body.engine,
    conversation: body.conversation,
    data: encryptSecret(ctx.config, (await zip(redact(text))).toString('base64')),
    ...(body.state
      ? { state: encryptSecret(ctx.config, JSON.parse(redact(JSON.stringify(body.state)))) }
      : {}),
    savedAt: (ctx.now ?? Date.now)(),
  });

  return json({ ok: true });
}
