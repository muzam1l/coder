/** The runner package machines download and verify, and the start command that runs a task from it. */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_ROOT } from '../../core/runtime';
import type { ServerContext } from '../context';
import { notFound } from '../routes/http';

export const RUNNER_IMAGE = 'ghcr.io/muzam1l/coder-runner:latest';
export function runnerHash(): string {
  const bundled = new URL('./runner.json', import.meta.url);
  const { hash } = JSON.parse(
    readFileSync(
      existsSync(bundled) ? bundled : path.join(PACKAGE_ROOT, 'dist/runner.json'),
      'utf8',
    ),
  );
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error('The runner package is missing; run bun run build.');

  return hash;
}

export function runnerTarball(server: string): string {
  return `${server.replace(/\/+$/, '')}/runner/${runnerHash()}.tgz`;
}

export async function runnerPackage(req: Request, ctx: ServerContext, params: { file: string }) {
  if (params.file !== `${runnerHash()}.tgz`) return notFound();
  try {
    const bundled = new URL('./runner.tgz', import.meta.url);
    const body = await readFile(
      existsSync(bundled) ? bundled : path.join(PACKAGE_ROOT, 'dist/runner.tgz'),
    );

    return new Response(body, {
      headers: {
        'content-type': 'application/gzip',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return notFound();
    throw error;
  }
}

export const SETUP_FAILED = `
const [file, id] = process.argv.slice(1);
const lines = require('fs').readFileSync(file, 'utf8').split('\\n').map(line => line.trim()).filter(Boolean);
const error = 'The machine failed: ' + lines.slice(-6).join(' ').slice(-800);
const login = process.env.CODER_LOGIN;
const url = process.env.CODER_SERVER.replace(/\\/+$/, '') + (login ? '/logins/' : '/tasks/') + encodeURIComponent(id) + (login ? '' : '/result');
fetch(url, {
  method: 'POST', signal: AbortSignal.timeout(10000),
  headers: { authorization: 'Bearer ' + process.env.CODER_TASK_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify(login ? { error } : { status: 'failed', error, machine: true }),
}).then(response => { if (!response.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });
`;

export function startCommand(tools = '', preflight = '', runtime = 'bun'): string {
  // The unpacked package answers `coder` on the engine's PATH, so flows run the same verified build.
  const extract = [
    'rm -rf .coder-runner/package && tar -xzf .coder-runner/package.tgz -C .coder-runner',
    'mkdir -p .coder-runner/bin',
    `printf '#!/bin/sh\nexec ${runtime} "$(dirname "$0")/../package/bin/coder.mjs" "$@"\n' > .coder-runner/bin/coder`,
    'chmod +x .coder-runner/bin/coder',
  ].join(' && ');
  const verified = `node -e 'const fs=require("fs"),crypto=require("crypto");process.exit(/^[a-f0-9]{64}$/.test(process.env.CODER_RUNNER_HASH||"")&&crypto.createHash("sha256").update(fs.readFileSync(".coder-runner/package.tgz")).digest("hex")===process.env.CODER_RUNNER_HASH?0:1)'`;
  const install = [
    'mkdir -p .coder-runner',
    'curl -fsSL --retry 2 --connect-timeout 10 --max-time 30 "${CODER_RUNNER_TARBALL_URL:?Runner package URL is required}" -o .coder-runner/package.tgz',
    `{ [ -z "$CODER_RUNNER_HASH" ] || ${verified}; }`,
    extract,
    ...(tools ? [tools] : []),
    'printf "%s" "$CODER_RUNNER_HASH" > .coder-runner/hash',
  ].join(' && ');
  const prepared = `[ -n "$CODER_RUNNER_HASH" ] && [ -f .coder-runner/package.tgz ] && [ "$(cat .coder-runner/hash 2>/dev/null)" = "$CODER_RUNNER_HASH" ] && ${verified}`;
  const run = [
    ...(preflight ? [preflight] : []),
    `if ${prepared}; then ${extract}; else ${install}; fi`,
    `PATH="$PWD/.coder-runner/bin:$PATH" CODER_NO_UPDATE_CHECK=1 ${runtime} .coder-runner/package/bin/coder.mjs agent run --task "$1"`,
  ].join(' && ');

  return [
    'out=$(mktemp)',
    `{ (${run}) 2>&1; echo $? >"$out.status"; } | tee "$out"`,
    'status=$(cat "$out.status")',
    '[ "$status" = 0 ] || { [ -n "$CODER_PREPARE" ] || { if command -v node >/dev/null 2>&1; then node -e "$2" "$out" "$1"; else bun -e "$2" "$out" "$1"; fi; }; }',
    'rm -f "$out" "$out.status"',
    'exit "$status"',
  ].join('; ');
}
