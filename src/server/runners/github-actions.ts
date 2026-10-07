import { decodeJson, encodeJson } from '../../utils/base64url';
import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { logLines, toolInstalls } from './local';

export const ACTIONS_WORKFLOW_YAML = `name: Coder agent
run-name: Coder agent \${{ inputs.task }}
on:
  workflow_dispatch:
    inputs:
      task: { required: true, type: string }
      server: { required: true, type: string }
      token: { required: true, type: string }
      mode: { required: true, type: string }
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g @wular/coder @anthropic-ai/claude-code @openai/codex
${toolInstalls()
  .map(install => `      - run: sudo sh -c '${install}'\n`)
  .join('')}      - run: coder agent run --task "$TASK"
        env:
          TASK: \${{ inputs.task }}
          CODER_SERVER: \${{ inputs.server }}
          CODER_TASK_TOKEN: \${{ inputs.token }}
          CODER_INBOX_MODE: \${{ inputs.mode }}
`;

export interface GithubActionsOptions {
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
          },
        }),
      },
      Math.max(1, deadline - Date.now()),
    );
    if (dispatched.status !== 204)
      throw new Error(`GitHub workflow dispatch failed: ${dispatched.status}`);
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

  async logs(handle: string, after = -1) {
    const { repo, run } = decode(handle);
    const list: Array<{ id: number }> = [];
    for (let page = 1; ; page++) {
      const jobs = await this.request(
        `/repos/${repo}/actions/runs/${run}/jobs?per_page=100&page=${page}`,
      );
      if (!jobs.ok) throw new Error(`GitHub workflow jobs failed: ${jobs.status}`);
      const body = (await jobs.json()) as { jobs: Array<{ id: number }> };
      list.push(...body.jobs);
      if (!jobs.headers.get('link')?.includes('rel="next"')) break;
    }

    const output: string[] = [];
    for (const job of list.sort((a, b) => a.id - b.id)) {
      const response = await this.request(`/repos/${repo}/actions/jobs/${job.id}/logs`);
      if (response.status === 404) return { lines: [], next: after };
      if (response.status === 302 && response.headers.get('location')) {
        const downloaded = await this.fetcher(response.headers.get('location')!, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (!downloaded.ok) throw new Error(`GitHub job log download failed: ${downloaded.status}`);
        output.push(await downloaded.text());
      } else if (response.ok) output.push(await response.text());
      else throw new Error(`GitHub job logs failed: ${response.status}`);
    }
    const all = logLines(output.join('\n'));
    return { lines: all.slice(after + 1), next: Math.max(after, all.length - 1) };
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
