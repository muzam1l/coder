/** Runner side of a subscription sign-in: the official, unmodified `claude` or `codex` login, reported to the server. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { taskServer } from './task';

const LOGIN_MS = 10 * 60 * 1000;
const TRIES = 10;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;

function command(engine: string, home: string) {
  if (engine === 'codex')
    return {
      file: 'codex',
      args: ['login', '--device-auth'],
      env: { CODEX_HOME: home },
    };
  // setup-token wants a wide terminal; `script` needs a real pipe on stdin, and `kill 0` ends `cat` with it.
  const inner = 'stty cols 4000 rows 50 2>/dev/null; exec claude setup-token';
  const script =
    process.platform === 'darwin'
      ? `script -q /dev/null sh -c '${inner}'`
      : `script -qfec '${inner}' /dev/null`;
  return {
    file: 'sh',
    args: ['-c', `cat | { ${script}; kill 0; }`],
    env: { CLAUDE_CONFIG_DIR: home, BROWSER: 'true' },
  };
}

function jwtClaims(token: unknown): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString());
  } catch {
    return {};
  }
}

/** Email and plan from Codex's `auth.json` id token. */
function codexAccount(authJson: string) {
  const claims = jwtClaims(
    (JSON.parse(authJson) as { tokens?: { id_token?: string } }).tokens?.id_token,
  );
  const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: unknown } | undefined;
  return {
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof auth?.chatgpt_plan_type === 'string' ? { plan: auth.chatgpt_plan_type } : {}),
  };
}

/** The sign-in link (and Codex's device code) once the output holds all of it; a URL counts only when whitespace ends it. */
export function signInLink(
  engine: string,
  raw: string,
): { url: string; code?: string } | undefined {
  const output = raw.replace(ANSI, '');
  // claude prints the URL as an OSC 8 hyperlink and wraps its visible text at the terminal width.
  const hyperlink = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(raw)?.[1];
  const url =
    engine === 'claude'
      ? (hyperlink ?? /https:\/\/\S*(?:oauth|authorize)\S*(?=\s)/.exec(output)?.[0])
      : /https:\/\/\S+(?=\s)/.exec(output)?.[0];
  const code = engine === 'codex' ? /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/.exec(output)?.[0] : undefined;
  if (!url || (engine === 'codex' && !code)) return undefined;
  return { url, ...(code ? { code } : {}) };
}

export async function runLogin(id: string, root: string): Promise<void> {
  const { server, token } = taskServer();
  delete process.env.CODER_TASK_TOKEN;
  delete process.env.CODER_LOGIN;
  const stopped = new AbortController();
  // Only the Coder server is called; a restart or dropped connection gets a few paced tries.
  const call = async <T>(suffix: string, body?: unknown): Promise<T> => {
    for (let tries = 1; ; tries++) {
      const response = await fetch(`${server}/logins/${encodeURIComponent(id)}${suffix}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(suffix ? { signal: stopped.signal } : {}),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch((error: Error) => {
        if (stopped.signal.aborted || tries >= TRIES) throw error;
        console.error(`coder runner: Coder server did not answer: ${error.message}`);
      });
      if (response?.ok) return (await response.json()) as T;
      if (response && (response.status < 500 || tries >= TRIES))
        throw new Error(`Coder server answered ${response.status}`);
      if (response) console.error(`coder runner: Coder server answered ${response.status}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  const { engine } = await call<{ engine: string }>('');
  const home = await fs.mkdtemp(path.join(root, '.login-'));
  const run = command(engine, home);
  const child = spawn(run.file, run.args, {
    env: { ...process.env, ...run.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  // The whole group, so `script` takes its terminal's program with it.
  const kill = () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {}
  };
  let raw = '';
  let output = '';
  let reported = false;
  // Where the current sign-in screen starts, and where the last pasted code went in.
  let from = 0;
  let sent: number | undefined;
  let retry: ReturnType<typeof setInterval> | undefined;
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timer = setTimeout(kill, LOGIN_MS);
  // A cancelled sign-in stops this process; the login's own group goes with it.
  for (const signal of SIGNALS) process.once(signal, kill);
  const answer = async () => {
    while (!stopped.signal.aborted) {
      const { code } = await call<{ code?: string }>('/input');
      if (code) {
        sent = raw.length;
        return void child.stdin.write(`${code}\r`);
      }
    }
  };
  const read = (chunk: Buffer) => {
    raw += chunk.toString();
    output = raw.replace(ANSI, '');
    if (!reported) {
      const link = signInLink(engine, raw.slice(from));
      if (link) {
        reported = true;
        clearInterval(retry);
        process.stdout.write('Sign-in link ready\n');
        void call('', link).catch(() => kill());
        if (engine === 'claude')
          answer().catch(() => {
            if (!stopped.signal.aborted) kill();
          });
      }
    }
    if (engine === 'claude' && /sk-ant-oat[\w-]+\s/.test(output)) kill();
    // A rejected code: Enter makes claude show a new link, which the dialog then offers.
    // Claude redraws in place and skips the spaces, so the prompt is matched without them.
    // It also takes keys a moment after the prompt draws, so Enter repeats until the link shows.
    const after = sent === undefined ? '' : raw.slice(sent).replace(ANSI, '').replace(/\s/g, '');
    if (after.includes('PressEntertoretry')) {
      sent = undefined;
      from = raw.length;
      reported = false;
      retry = setInterval(() => child.stdin.write('\r'), 1000);
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);

  try {
    const code = await finished;
    stopped.abort();
    const oauth = /sk-ant-oat[A-Za-z0-9_-]+/.exec(output)?.[0];
    if (engine === 'claude' && oauth) {
      const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(output)?.[0];
      await call('', {
        result: {
          env: { CLAUDE_CODE_OAUTH_TOKEN: oauth },
          ...(email ? { account: { email } } : {}),
        },
      });
    } else if (engine === 'codex' && code === 0) {
      const authJson = await fs.readFile(path.join(home, 'auth.json'), 'utf8');
      await call('', {
        result: {
          env: { CODEX_AUTH_JSON: authJson },
          account: codexAccount(authJson),
        },
      });
    } else
      await call('', {
        error: reported
          ? 'Sign-in did not finish. Start again.'
          : `${engine} sign-in could not start.`,
      }).catch(() => {});
    process.stdout.write('Sign-in finished\n');
  } finally {
    clearTimeout(timer);
    clearInterval(retry);
    for (const signal of SIGNALS) process.off(signal, kill);
    stopped.abort();
    kill();
    await fs.rm(home, { recursive: true, force: true });
  }
}
