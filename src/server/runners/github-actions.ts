import { decodeJson, encodeJson } from '../../utils/base64url';
import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { RUNNER_IMAGE, startCommand, SETUP_FAILED, runnerTarball } from '.';

export function actionsWorkflow(): string {
  return `name: Coder agent
run-name: Coder agent \${{ inputs.task }}
on:
  workflow_dispatch:
    inputs:
      task: { required: true, type: string }
      server: { required: true, type: string }
      token: { required: true, type: string }
      mode: { required: true, type: string }
      tarball: { required: true, type: string }
jobs:
  run:
    runs-on: ubuntu-latest
    container: ${RUNNER_IMAGE}
    steps:
      - run: |
          sh -c '${startCommand().replaceAll("'", "'\\''")}' coder-task "$TASK" '${SETUP_FAILED.replaceAll("'", "'\\''").trim().replaceAll('\n', ' ')}'
        env:
          TASK: \${{ inputs.task }}
          CODER_SERVER: \${{ inputs.server }}
          CODER_TASK_TOKEN: \${{ inputs.token }}
          CODER_INBOX_MODE: \${{ inputs.mode }}
          CODER_RUNNER_TARBALL_URL: \${{ inputs.tarball }}
`;
}

export interface GithubActionsOptions {
  tarballUrl?: string;
  token?: string;
  repo?: string;
  workflow?: string;
  ref?: string;
  fetch?: typeof fetch;
  lookupTimeoutMs?: number;
  pollIntervalMs?: number;
}

type GithubHandle = { repo: string; run: number };
const decode = (value: string) => decodeJson<GithubHandle>(value);

export class GithubActionsRunner implements Runner {
  readonly kind = 'github-actions' as const;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GithubActionsOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}, timeout = 10_000): Promise<Response> {
    if (!this.options.token) throw new Error('RUNNER_CONFIG.token is required for github-actions');
    const signal = AbortSignal.timeout(timeout);
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        ...init,
        signal,
        redirect: 'manual',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          'user-agent': 'coder',
          'x-github-api-version': '2022-11-28',
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

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    const repo =
      this.options.repo ?? (task.event?.repo && `${task.event.repo.owner}/${task.event.repo.name}`);
    if (!repo) throw new Error('The github-actions runner requires a repository');
    const deadline = Date.now() + (this.options.lookupTimeoutMs ?? 25_000);
    const workflow = encodeURIComponent(this.options.workflow ?? 'coder-agent.yml');
    const taskRepo = task.event?.repo;
    let ref =
      this.options.ref ??
      (taskRepo && `${taskRepo.owner}/${taskRepo.name}` === repo
        ? taskRepo.defaultBranch
        : undefined);
    if (!ref) {
      const response = await this.request(`/repos/${repo}`, {}, Math.max(1, deadline - Date.now()));
      if (!response.ok) throw new Error(`GitHub repository lookup failed: ${response.status}`);
      const body = (await response.json()) as { default_branch?: string };
      if (!body.default_branch) throw new Error('GitHub repository has no default branch');
      ref = body.default_branch;
    }
    const path = `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&branch=${encodeURIComponent(ref)}`;
    const previous = await this.request(path, {}, Math.max(1, deadline - Date.now()));
    if (!previous.ok) throw new Error(`GitHub workflow run lookup failed: ${previous.status}`);
    const baseline = (await previous.json()) as { workflow_runs: Array<{ id: number }> };
    const latest = Math.max(0, ...baseline.workflow_runs.map(run => run.id));
    const dispatched = await this.request(
      `/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref,
          inputs: {
            task: task.id,
            server: env.CODER_SERVER,
            token: env.CODER_TASK_TOKEN,
            mode: env.CODER_INBOX_MODE,
            tarball: this.options.tarballUrl ?? runnerTarball(),
          },
        }),
      },
      Math.max(1, deadline - Date.now()),
    );
    if (dispatched.status !== 204) {
      const body = (await dispatched.json().catch(() => ({}))) as { message?: string };
      if (
        dispatched.status === 422 &&
        /unexpected inputs provided/i.test(body.message ?? '') &&
        /\btarball\b/i.test(body.message ?? '')
      )
        throw new Error(
          'The saved GitHub workflow lacks the tarball input; regenerate it with coder server workflow.',
        );
      throw new Error(`GitHub workflow dispatch failed: ${dispatched.status}`);
    }
    do {
      for (let page = 1; Date.now() < deadline; page++) {
        const runs = await this.request(
          `${path}&page=${page}`,
          {},
          Math.max(1, deadline - Date.now()),
        );
        if (!runs.ok) throw new Error(`GitHub workflow run lookup failed: ${runs.status}`);
        const body = (await runs.json()) as {
          workflow_runs: Array<{ id: number; display_title: string }>;
        };
        const run = body.workflow_runs.find(
          item => item.id > latest && item.display_title === `Coder agent ${task.id}`,
        );
        if (run) return encodeJson({ repo, run: run.id } satisfies GithubHandle);
        if (!runs.headers.get('link')?.includes('rel="next"')) break;
      }
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.min(this.options.pollIntervalMs ?? 1000, Math.max(0, deadline - Date.now())),
        ),
      );
    } while (Date.now() < deadline);
    throw new Error(`GitHub workflow run for task ${task.id} was not found before timeout`);
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
