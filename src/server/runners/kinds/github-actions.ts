import { decodeJson, encodeJson } from '../../../utils/crypto';
import type { AgentTask } from '../../../agent/types';
import type { Runner } from '..';
import { RUNNER_IMAGE } from '../package';
import { actionsJobs, startEnv } from '../../../runner/protocol';

/** The workflow file the runner dispatches, in `.github/workflows`. */
export const WORKFLOW_FILE = 'coder-runner.yml';

/** The workflow a repository runs tasks with. It holds nothing per release: the server names the image and the package hash with each dispatch. */
export function actionsWorkflow(): string {
  return `name: Coder runner
run-name: Coder runner \${{ inputs.task }}
on:
  workflow_dispatch:
    inputs:
      task: { required: true, type: string }
      server: { required: true, type: string }
      claim: { required: true, type: string }
      image: { required: true, type: string }
      tarball: { required: true, type: string }
      hash: { required: true, type: string }
jobs:
  run:
    runs-on: ubuntu-latest
    # Lets the job prove this run to the Coder server; it gets no other GitHub permission.
    permissions: { id-token: write }
    container: \${{ inputs.image }}
    env:
      CODER_SERVER: \${{ inputs.server }}
      CODER_TASK_CLAIM: \${{ inputs.claim }}
      CODER_INBOX_MODE: poll
      CODER_RUNNER_TARBALL_URL: \${{ inputs.tarball }}
      CODER_RUNNER_HASH: \${{ inputs.hash }}
      CODER_NO_UPDATE_CHECK: 1
    steps:
      - name: Download the Coder runner and check its hash
        run: |
          mkdir -p .coder-runner/bin
          curl -fsSL --retry 2 "$CODER_RUNNER_TARBALL_URL" -o .coder-runner/package.tgz
          echo "$CODER_RUNNER_HASH  .coder-runner/package.tgz" | sha256sum -c -
          tar -xzf .coder-runner/package.tgz -C .coder-runner
          printf '#!/bin/sh\\nexec bun "%s" "$@"\\n' "$PWD/.coder-runner/package/bin/coder.mjs" > .coder-runner/bin/coder
          chmod +x .coder-runner/bin/coder
          echo "$PWD/.coder-runner/bin" >> "$GITHUB_PATH"
      - name: Run the task
        env:
          TASK: \${{ inputs.task }}
        run: coder agent run --task "$TASK"
`;
}

/** GitHub REST headers for `token`. */
export const githubHeaders = (token: string) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'user-agent': 'coder',
  'x-github-api-version': '2022-11-28',
});

interface GithubActionsOptions {
  /** A token, or the GitHub app's token for the repository, minted when needed. */
  token?: string | (() => Promise<string>);
  repo?: string;
  workflow?: string;
  fetch?: typeof fetch;
  lookupTimeoutMs?: number;
}

type GithubHandle = { repo: string; run: number };
const decode = (value: string) => decodeJson<GithubHandle>(value);

export class GithubActionsRunner implements Runner {
  readonly kind = 'github-actions' as const;
  private readonly fetcher: typeof fetch;

  // A minted token has at least 5 minutes left, so the runner reuses it for 4.
  private held?: { token: string; until: number };
  private readonly jobs: ReturnType<typeof actionsJobs>;

  constructor(private readonly options: GithubActionsOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.jobs = actionsJobs(this.fetcher);
  }

  private async bearer(): Promise<string> {
    const { token } = this.options;
    if (!token) throw new Error('RUNNER_CONFIG.token is required for github-actions');
    if (typeof token === 'string') return token;
    const now = Date.now();
    if (!this.held || this.held.until <= now)
      this.held = { token: await token(), until: now + 4 * 60_000 };

    return this.held.token;
  }

  private async request(path: string, init: RequestInit = {}, timeout = 10_000): Promise<Response> {
    const bearer = await this.bearer();
    const signal = AbortSignal.timeout(timeout);
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        ...init,
        signal,
        redirect: 'manual',
        headers: {
          ...githubHeaders(bearer),
          'content-type': 'application/json',
          ...init.headers,
        },
      });
      if (
        (init.method ?? 'GET') !== 'GET' ||
        attempt === 2 ||
        (response.status !== 429 && response.status < 500)
      )
        return response;
      const retry = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          done();
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            done();
            resolve();
          },
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : 100 * 2 ** attempt,
        );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }

  async start(
    task: AgentTask,
    env: Record<string, string>,
    _credential?: Record<string, string>,
    options: { claim?: () => Promise<string> } = {},
  ): Promise<string> {
    if (!options.claim) throw new Error('The github-actions runner starts with a claim code only');
    const repo =
      this.options.repo ?? (task.event?.repo && `${task.event.repo.owner}/${task.event.repo.name}`);
    if (!repo) throw new Error('The github-actions runner requires a repository');
    const deadline = Date.now() + (this.options.lookupTimeoutMs ?? 25_000);
    const workflow = encodeURIComponent(this.options.workflow ?? WORKFLOW_FILE);
    const taskRepo = task.event?.repo;
    let ref =
      taskRepo && `${taskRepo.owner}/${taskRepo.name}` === repo
        ? taskRepo.defaultBranch
        : undefined;
    if (!ref) {
      const response = await this.request(`/repos/${repo}`, {}, Math.max(1, deadline - Date.now()));
      if (!response.ok) throw new Error(`GitHub repository lookup failed: ${response.status}`);
      const body = (await response.json()) as { default_branch?: string };
      if (!body.default_branch) throw new Error('GitHub repository has no default branch');
      ref = body.default_branch;
    }
    const machine = startEnv(env);
    const dispatched = await this.request(
      `/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: { 'x-github-api-version': '2026-03-10' },
        body: JSON.stringify({
          ref,
          inputs: {
            task: task.id,
            server: machine.CODER_SERVER,
            claim: await options.claim(),
            image: RUNNER_IMAGE,
            tarball: machine.CODER_RUNNER_TARBALL_URL,
            hash: machine.CODER_RUNNER_HASH,
          },
        }),
      },
      Math.max(1, deadline - Date.now()),
    );
    if (dispatched.status === 422)
      throw new Error(
        `GitHub workflow dispatch failed: 422. ${repo}'s .github/workflows/${decodeURIComponent(workflow)} is out of date; add this runner again to update it.`,
      );
    if (dispatched.status !== 200)
      throw new Error(`GitHub workflow dispatch failed: ${dispatched.status}`);
    const run = (await dispatched.json()) as { workflow_run_id?: number };
    if (!Number.isSafeInteger(run.workflow_run_id) || run.workflow_run_id! <= 0)
      throw new Error('GitHub workflow dispatch returned no run id');

    return encodeJson({ repo, run: run.workflow_run_id! } satisfies GithubHandle);
  }

  async verifyJob(handle: string, token: string, audience: string): Promise<boolean> {
    const { repo, run } = decode(handle);
    const job = await this.jobs(token, audience);

    return job?.repository.toLowerCase() === repo.toLowerCase() && job.run === String(run);
  }

  async status(handle: string) {
    const { repo, run } = decode(handle);
    const response = await this.request(`/repos/${repo}/actions/runs/${run}`);
    if (response.status === 404) return { state: 'exited' as const, code: 1 };
    if (!response.ok) throw new Error(`GitHub workflow status failed: ${response.status}`);
    const body = (await response.json()) as {
      status?: string;
      conclusion?: string;
    };
    if (body.status !== 'completed') return { state: 'running' as const };
    return {
      state: 'exited' as const,
      code: body.conclusion === 'success' ? 0 : 1,
    };
  }

  async stop(handle: string): Promise<void> {
    const { repo, run } = decode(handle);
    const response = await this.request(`/repos/${repo}/actions/runs/${run}/cancel`, {
      method: 'POST',
    });
    if (response.status !== 202 && response.status !== 409)
      throw new Error(`GitHub workflow cancellation failed: ${response.status}`);
  }
}

const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');

/** Adds the workflow file on the default branch, which GitHub dispatches from, or brings it up to date. */
export async function ensureWorkflow(
  config: Record<string, string>,
  token: string,
  request: typeof fetch,
): Promise<void> {
  const call = (path: string, init: { method?: string; body?: string } = {}) =>
    request(`https://api.github.com/repos/${repoPath(config.repo!)}/contents/${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
      headers: githubHeaders(token),
    });
  const file = `.github/workflows/${encodeURIComponent(config.workflow || WORKFLOW_FILE)}`;
  const failed = (status: number) =>
    new Error(
      `Coder could not add ${file} to ${config.repo} (HTTP ${status}). Add it there with: mkdir -p .github/workflows && coder server workflow > ${file}`,
    );

  const found = await call(file);
  if (!found.ok && found.status !== 404) throw failed(found.status);
  const current = found.ok
    ? ((await found.json()) as { content?: string; sha?: string })
    : undefined;
  const content = actionsWorkflow();
  if (current && Buffer.from(current.content ?? '', 'base64').toString() === content) return;
  const saved = await call(file, {
    method: 'PUT',
    body: JSON.stringify({
      message: current ? 'Update the Coder runner workflow' : 'Add the Coder runner workflow',
      content: Buffer.from(content).toString('base64'),
      ...(current ? { sha: current.sha } : {}),
    }),
  });
  if (!saved.ok) throw failed(saved.status);
}

export async function checkGithubActions(
  config: Record<string, unknown>,
  request: (url: string) => Promise<Response>,
): Promise<string> {
  const repo = repoPath(String(config.repo));
  await request(`https://api.github.com/repos/${repo}`);
  await request(
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(String(config.workflow || WORKFLOW_FILE))}`,
  );
  return 'Repository and workflow are accessible';
}

export function validateGithubActionsConfig(config: Record<string, string>): void {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(config.repo!) ||
    config.repo!.split('/').some(part => /^\.+$/.test(part))
  )
    throw new Error('Repository must be owner/repo');
  if (config.workflow && !/^[\w-][\w.-]*\.ya?ml$/.test(config.workflow))
    throw new Error('Workflow file must be a .yml file name in .github/workflows');
}
