import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { watchChanges } from '../../utils/fsx';

function write(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temp, file);
}

/** Shared detached-worker transport; engine adapters validate ownership and interpret replies. */
export function serveControl(
  prefix: string,
  handle: (request: any, closing: boolean) => Promise<any>,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const processing = new Map<string, Promise<void>>();
  let closing = false;
  const scan = () => {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.request.json')) continue;
        const id = name.slice(0, -'.request.json'.length);
        const request = path.join(directory, name);
        const response = path.join(directory, `${id}.response.json`);
        if (fs.existsSync(response)) {
          fs.rmSync(request, { force: true });
          continue;
        }
        if (processing.has(id)) continue;
        const claimed = `${request}.processing`;
        fs.renameSync(request, claimed);
        const work = (async () => {
          let reply;
          try {
            const input = JSON.parse(fs.readFileSync(claimed, 'utf8'));
            if (input.id !== id) throw new Error('Invalid control request id.');
            reply = { id, result: await handle(input, closing) };
          } catch (error) {
            const failure = error as Error & { retryable?: boolean; rpcCode?: number };
            reply = {
              id,
              error: {
                message: failure.message,
                retryable: failure.retryable === true,
                rpcCode: failure.rpcCode,
              },
            };
          }
          write(response, reply);
          fs.rmSync(claimed, { force: true });
        })();
        processing.set(id, work);
        void work.finally(() => processing.delete(id)).catch(() => {});
      }
    } catch {
      // A stopped task may remove its endpoint during teardown.
    }
  };
  const changes = watchChanges(directory, scan);
  const recovery = setInterval(scan, 30000);
  recovery.unref();
  return {
    endpoint: `file:${directory}`,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(recovery);
      const deadline = Date.now() + 3000;
      try {
        for (;;) {
          scan();
          await Promise.allSettled([...processing.values()]);
          await nextTurn();
          // Readers remove their marker after consuming a reply; retain receipts until then.
          if (
            !fs.existsSync(directory) ||
            !fs.readdirSync(directory).some(name => name.endsWith('.reader'))
          )
            break;
          if (Date.now() >= deadline) break;
          await changes.wait(deadline - Date.now());
        }
      } finally {
        changes.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export async function requestControl(
  endpoint: string | null | undefined,
  request: { id: string; method: string; params: unknown; command?: unknown },
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; retryable: boolean; detail: string; result?: any }> {
  if (!endpoint) return { ok: false, retryable: true, detail: `${label} endpoint is not ready.` };
  if (!endpoint.startsWith('file:') || endpoint.length === 5)
    return { ok: false, retryable: false, detail: `Unsupported ${label} endpoint: ${endpoint}` };
  const directory = endpoint.slice(5);
  const changes = watchChanges(directory);
  const reader = path.join(directory, `${randomUUID()}.reader`);
  let published = false;
  try {
    fs.writeFileSync(reader, '');
    const response = path.join(directory, `${request.id}.response.json`);
    if (!fs.existsSync(response))
      write(path.join(directory, `${request.id}.request.json`), request);
    published = true;
    const deadline = Date.now() + timeoutMs;
    await nextTurn();
    const result = await changes.until(
      () => {
        try {
          const reply = JSON.parse(fs.readFileSync(response, 'utf8'));
          if (!request.command || reply?.error?.retryable) fs.rmSync(response, { force: true });
          if (reply?.id !== request.id) throw new Error(`Malformed ${label} response id.`);
          if (reply.error)
            return {
              ok: false,
              retryable: reply.error.retryable === true,
              detail: String(reply.error.message),
            };
          if (!('result' in reply)) throw new Error(`Malformed ${label} response.`);
          return {
            ok: true,
            retryable: false,
            result: reply.result,
            detail: `${label} accepted control.`,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if (!fs.existsSync(directory))
            throw new Error(
              `${label} endpoint closed after control publication; acceptance is unknown.`,
            );
        }
        return undefined;
      },
      Math.max(0, deadline - Date.now()),
    );
    if (result) return result;
    throw new Error(`Timed out waiting for ${label} acknowledgement.`);
  } catch (error) {
    return {
      ok: false,
      retryable: !published && (error as NodeJS.ErrnoException).code === 'ENOENT',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    changes.close();
    fs.rmSync(reader, { force: true });
  }
}
