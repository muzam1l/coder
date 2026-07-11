import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Job } from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

const CODER_HOME_ENV = "CODER_HOME";

export function resolveCoderHome(): string {
  return path.resolve(process.env[CODER_HOME_ENV] || path.join(os.homedir(), ".coder"));
}

// Memoized per cwd: this shells out to git, and path helpers call it once per
// job (a `coder list` over N jobs would otherwise spawn N git processes).
const workspaceRootCache = new Map<string, string>();

export function resolveWorkspaceRoot(cwd: string): string {
  const cached = workspaceRootCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    root = cwd;
  }
  workspaceRootCache.set(cwd, root);
  return root;
}

const stateDirCache = new Map<string, string>();

export function resolveStateDir(cwd: string): string {
  const cached = stateDirCache.get(cwd);
  if (cached !== undefined) {
    return cached;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalRoot = workspaceRoot;
  try {
    canonicalRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalRoot = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 12);
  const stateDir = path.join(resolveCoderHome(), "state", `${slug}-${hash}`);
  stateDirCache.set(cwd, stateDir);
  return stateDir;
}

export function resolveJobsDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveJobDir(cwd: string, jobId: string): string {
  return path.join(resolveJobsDir(cwd), jobId);
}

export function generateJobId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `coder-${Date.now().toString(36)}-${random}`;
}

export function writeJob(cwd: string, jobId: string, patch: Partial<Job>): Job {
  const jobDir = resolveJobDir(cwd, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, "job.json");
  const existing: Job =
    readJob(cwd, jobId) ?? ({ id: jobId, createdAt: new Date().toISOString(), status: "queued" } as Job);
  const next: Job = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(jobFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function readJob(cwd: string, jobId: string): Job | null {
  const jobFile = path.join(resolveJobDir(cwd, jobId), "job.json");
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8")) as Job;
  } catch {
    return null;
  }
}

export function deleteJob(cwd: string, jobId: string): boolean {
  const jobDir = resolveJobDir(cwd, jobId);
  if (!fs.existsSync(jobDir)) {
    return false;
  }
  fs.rmSync(jobDir, { recursive: true, force: true });
  return true;
}

// Whether a process is still alive. Signal 0 tests existence without delivering
// a signal; EPERM means it exists but we may not signal it (still alive).
function isPidAlive(pid?: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Epoch ms when the process holding `pid` started, or null if unknown (process
// gone, or `ps` unavailable e.g. on Windows). Used to tell our worker apart from
// an unrelated process that later recycled the same pid.
function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = out ? Date.parse(out) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Our worker is spawned within moments of the task being created, so a live pid
// whose process started well after the task's createdAt is a recycled pid — the
// real worker is gone.
function pidIsOurWorker(pid: number, job: Job): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }
  const started = processStartMs(pid);
  const created = Date.parse(job.createdAt ?? "");
  if (started === null || !Number.isFinite(created)) {
    return true; // can't verify start time — trust liveness
  }
  return started <= created + 60_000;
}

// How long a running/queued task with no recorded pid may sit untouched before
// it is treated as dead. Long enough to clear the brief queued-before-pid window
// on a freshly created task.
const STALE_NO_PID_MS = 60_000;

// Self-heal a zombie: a task marked running/queued whose worker process is gone
// (crash, kill, reboot) can never reach a terminal status on its own, so mark it
// failed. Detected either by a dead pid, or — for tasks with no pid recorded (an
// older version, or a crash before the pid was written) — by staleness.
export function reconcileJob(cwd: string, job: Job): Job {
  if (job.status !== "running" && job.status !== "queued") {
    return job;
  }
  let dead: boolean;
  if (job.pid) {
    dead = !pidIsOurWorker(job.pid, job);
  } else {
    const ts = Date.parse(job.updatedAt ?? job.createdAt ?? "");
    dead = Number.isFinite(ts) && Date.now() - ts > STALE_NO_PID_MS;
  }
  if (dead) {
    return writeJob(cwd, job.id, {
      status: "failed",
      error: "worker exited without finishing",
      completedAt: new Date().toISOString(),
    });
  }
  return job;
}

export function listJobs(cwd: string): Job[] {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  return fs
    .readdirSync(jobsDir)
    .map((id) => readJob(cwd, id))
    .filter((job): job is Job => job !== null)
    .map((job) => reconcileJob(cwd, job))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function findJob(cwd: string, reference?: string): Job | null {
  const jobs = listJobs(cwd);
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const prefixed = jobs.filter((job) => job.id.startsWith(reference));
  if (prefixed.length === 1) {
    return prefixed[0]!;
  }
  if (prefixed.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer id.`);
  }
  return null;
}

// Cheap activity heartbeat: engines touch this file (throttled) on any server
// event — including ones we don't log, like command output deltas — so idle
// means "time since the agent emitted anything", not "since we logged".
export function touchActivity(cwd: string, jobId: string): void {
  const jobDir = resolveJobDir(cwd, jobId);
  try {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "heartbeat"), "", "utf8");
  } catch {
    // Best-effort: a missed heartbeat only overstates idle time.
  }
}

// Most recent sign of life for a job: the latest of its job.json update, its
// last log append, and its heartbeat. Uses file mtimes so it stays O(1) per job.
export function lastActivityAt(cwd: string, job: Job): string | undefined {
  const jobDir = resolveJobDir(cwd, job.id);
  let best = Date.parse(job.updatedAt ?? "") || 0;
  for (const file of ["log.jsonl", "heartbeat"]) {
    try {
      best = Math.max(best, fs.statSync(path.join(jobDir, file)).mtimeMs);
    } catch {
      // File not created yet.
    }
  }
  return best ? new Date(best).toISOString() : undefined;
}

export interface JobLogEntry {
  at?: string;
  message?: string;
  kind?: string;
  [key: string]: unknown;
}

// Block until a task reaches a terminal status, then return the final job.
// Reconciles each poll so a dead worker (zombie) resolves instead of hanging.
export async function waitForTerminalJob(cwd: string, job: Job, pollMs = 400): Promise<Job> {
  let current = job;
  while (!TERMINAL_STATUSES.includes(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = reconcileJob(cwd, readJob(cwd, current.id) ?? current);
  }
  return current;
}

export function appendJobLog(cwd: string, jobId: string, entry: JobLogEntry): void {
  const jobDir = resolveJobDir(cwd, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.appendFileSync(path.join(jobDir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

export function readJobLog(cwd: string, jobId: string, maxLines = 40): JobLogEntry[] {
  const logFile = path.join(resolveJobDir(cwd, jobId), "log.jsonl");
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line): JobLogEntry => {
    try {
      return JSON.parse(line) as JobLogEntry;
    } catch {
      return { message: line };
    }
  });
}
