import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODER_HOME_ENV = "CODER_HOME";

export function resolveCoderHome() {
  return path.resolve(process.env[CODER_HOME_ENV] || path.join(os.homedir(), ".coder"));
}

export function resolveWorkspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return cwd;
  }
}

export function resolveStateDir(cwd) {
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
  return path.join(resolveCoderHome(), "state", `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveJobDir(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), jobId);
}

export function generateJobId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `coder-${Date.now().toString(36)}-${random}`;
}

export function writeJob(cwd, jobId, patch) {
  const jobDir = resolveJobDir(cwd, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, "job.json");
  const existing = readJob(cwd, jobId) ?? { id: jobId, createdAt: new Date().toISOString() };
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(jobFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function readJob(cwd, jobId) {
  const jobFile = path.join(resolveJobDir(cwd, jobId), "job.json");
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  return fs
    .readdirSync(jobsDir)
    .map((id) => readJob(cwd, id))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function findJob(cwd, reference) {
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
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer id.`);
  }
  return null;
}

export function appendJobLog(cwd, jobId, entry) {
  const jobDir = resolveJobDir(cwd, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.appendFileSync(path.join(jobDir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

export function readJobLog(cwd, jobId, maxLines = 40) {
  const logFile = path.join(resolveJobDir(cwd, jobId), "log.jsonl");
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { message: line };
    }
  });
}
