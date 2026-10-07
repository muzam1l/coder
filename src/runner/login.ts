/** Runner side of a subscription sign-in: the official, unmodified `claude` or `codex` login, reported to the server. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { taskServer } from './task';

const LOGIN_MS = 10 * 60 * 1000;
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
  const call = async <T>(suffix: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server}/logins/${encodeURIComponent(id)}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(suffix ? { signal: stopped.signal } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Coder server answered ${response.status}`);
    return (await response.json()) as T;
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
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timer = setTimeout(kill, LOGIN_MS);
  const answer = async () => {
    while (!stopped.signal.aborted) {
      const { code } = await call<{ code?: string }>('/input');
      if (code) return void child.stdin.write(`${code}\r`);
    }
  };
  const read = (chunk: Buffer) => {
    raw += chunk.toString();
    output = raw.replace(ANSI, '');
    if (!reported) {
      const link = signInLink(engine, raw);
      if (link) {
        reported = true;
        process.stdout.write('Sign-in link ready\n');
        void call('', link).catch(() => kill());
        if (engine === 'claude')
          answer().catch(() => {
            if (!stopped.signal.aborted) kill();
          });
      }
    }
    if (engine === 'claude' && /sk-ant-oat[\w-]+\s/.test(output)) kill();
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
    stopped.abort();
    kill();
    await fs.rm(home, { recursive: true, force: true });
  }
}
