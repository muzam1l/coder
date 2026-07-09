/**
 * Auto-mode approval engine. Codex runs with approvalPolicy "on-request" (or
 * "untrusted"): whenever it wants to escalate beyond the sandbox it sends a
 * server request, and this module answers it like the CLI prompt would —
 * except a policy decides instead of a human, and genuinely ambiguous asks are
 * escalated to the caller through pending-approval files.
 *
 * Protocol (codex app-server v2):
 * - item/commandExecution/requestApproval -> { decision }
 * - item/fileChange/requestApproval       -> { decision }
 * decision: "accept" | "acceptForSession" | "decline" | "cancel"
 */
import fs from "node:fs";
import path from "node:path";

const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";

// Never allowed, no matter what the task says. Git stays read-only by policy.
const GIT_WRITE_SUBCOMMANDS = new Set([
  "commit",
  "checkout",
  "switch",
  "restore",
  "stash",
  "reset",
  "rebase",
  "merge",
  "push",
  "pull",
  "cherry-pick",
  "revert",
  "clean",
  "am",
  "apply",
  "tag",
  "branch",
  "worktree",
  "filter-branch",
  "filter-repo",
  "gc",
  "prune",
  "reflog",
  "remote",
  "submodule",
  "config"
]);

const HARD_DENY_PATTERNS = [
  /\bsudo\b/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b.*\s(\/\*?|~\/?|\$HOME\/?)(\s|$)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bmkfs\b|\bdiskutil\s+erase/i,
  /\b(chmod|chown)\b.*-R.*\s\/(\s|$)/,
  /\bkill(all)?\s+-9\s+1\b/,
  /curl[^|;&]*\|\s*(ba|z|da)?sh\b/,
  /wget[^|;&]*\|\s*(ba|z|da)?sh\b/,
  /\blaunchctl\b|\bsystemctl\b/,
  /\bdefaults\s+write\b/,
  />\s*\/dev\/(sd|disk)/
];

// First-token allowlist for commands that are safe to run un-sandboxed.
const SAFE_BINARIES = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "ugrep",
  "find",
  "fd",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whoami",
  "pwd",
  "echo",
  "printf",
  "env",
  "date",
  "uname",
  "sw_vers",
  "jq",
  "sort",
  "uniq",
  "tr",
  "cut",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "xxd",
  "shasum",
  "sha256sum",
  "md5",
  "tree",
  "ps"
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "shortlog",
  "grep",
  "branch", // bare `git branch` lists; write forms are caught by flag check below
  "stash" // bare `git stash list` only; other forms caught below
]);

// Runner binaries where the subcommand decides safety.
const RUNNER_SAFE_SUBCOMMANDS = new Map([
  ["npm", new Set(["test", "run", "exec", "ls", "view", "why", "outdated", "ping"])],
  ["pnpm", new Set(["test", "run", "exec", "ls", "why", "outdated"])],
  ["yarn", new Set(["test", "run", "why", "info"])],
  ["bun", new Set(["test", "run", "x", "pm"])],
  ["npx", null],
  ["bunx", null],
  ["node", null],
  ["python", null],
  ["python3", null],
  ["tsc", null],
  ["eslint", null],
  ["prettier", null],
  ["vitest", null],
  ["jest", null],
  ["pytest", null],
  ["cargo", new Set(["build", "test", "check", "clippy", "fmt", "run", "bench", "doc", "tree", "metadata"])],
  ["go", new Set(["build", "test", "vet", "run", "fmt", "list", "env", "version"])],
  ["make", null],
  ["turbo", null]
]);

function firstShellCommand(command) {
  // Unwrap `bash -lc "..."` / `sh -c '...'` wrappers so the inner command is judged.
  const wrapped = command.match(/^\s*(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*(?:-c\s+)?(["'])([\s\S]*)\1\s*$/);
  return wrapped ? wrapped[2] : command;
}

function tokenize(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

function classifyGit(tokens) {
  const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
  if (!sub) {
    return { decision: "accept", reason: "bare git" };
  }
  if (sub === "branch" && tokens.some((t) => /^-(d|D|m|M|c|C|f|u)|^--(delete|move|copy|force|set-upstream)/.test(t))) {
    return { decision: "decline", reason: "git branch write operation (git is read-only for Coder)" };
  }
  if (sub === "stash") {
    const stashSub = tokens.find((t, i) => i > 1 && !t.startsWith("-"));
    if (stashSub === "list" || stashSub === "show") {
      return { decision: "accept", reason: `git stash ${stashSub} is read-only` };
    }
    return { decision: "decline", reason: "git stash write operation (git is read-only for Coder)" };
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    return { decision: "accept", reason: `git ${sub} is read-only` };
  }
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return { decision: "decline", reason: `git ${sub} is a write operation (git is read-only for Coder)` };
  }
  return { decision: "escalate", reason: `unrecognized git subcommand: ${sub}` };
}

/**
 * Decide a command approval without human input.
 * Returns { decision: "accept" | "decline" | "escalate", reason }.
 */
export function decideCommand(rawCommand, context: any = {}) {
  const command = firstShellCommand(String(rawCommand ?? ""));
  if (!command.trim()) {
    return { decision: "escalate", reason: "empty command" };
  }

  for (const pattern of HARD_DENY_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: "decline", reason: `matches hard-deny pattern ${pattern}` };
    }
  }

  // Command/process substitution can smuggle a second command past the
  // first-token checks (`echo $(git push)`); never auto-accept it.
  if (/\$\(|`|<\(/.test(command)) {
    return { decision: "escalate", reason: "contains command substitution" };
  }

  // Compound commands: every segment must be individually acceptable.
  const segments = command.split(/&&|\|\||;|\||\r?\n/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length > 1) {
    let worst = { decision: "accept", reason: "all segments safe" };
    for (const segment of segments) {
      const result = decideCommand(segment, context);
      if (result.decision === "decline") {
        return result;
      }
      if (result.decision === "escalate") {
        worst = result;
      }
    }
    return worst;
  }

  const tokens = tokenize(command);
  const binary = path.basename(tokens[0] ?? "");

  if (binary === "git") {
    return classifyGit(tokens);
  }

  // Network escalations are their own category: only allow allowlisted hosts.
  if (context.networkHost) {
    const allowedHosts = context.allowedNetworkHosts ?? [];
    if (allowedHosts.some((host) => context.networkHost === host || context.networkHost.endsWith(`.${host}`))) {
      return { decision: "accept", reason: `network host ${context.networkHost} is allowlisted` };
    }
    return { decision: "escalate", reason: `network access to ${context.networkHost}` };
  }

  if (SAFE_BINARIES.has(binary)) {
    return { decision: "accept", reason: `${binary} is on the safe-binaries list` };
  }

  const runnerSubcommands = RUNNER_SAFE_SUBCOMMANDS.get(binary);
  if (runnerSubcommands !== undefined) {
    if (runnerSubcommands === null) {
      return { decision: "accept", reason: `${binary} is a trusted runner` };
    }
    const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-"));
    if (sub && runnerSubcommands.has(sub)) {
      return { decision: "accept", reason: `${binary} ${sub} is a trusted runner command` };
    }
    return { decision: "escalate", reason: `${binary} ${sub ?? ""} is not on the trusted subcommand list` };
  }

  return { decision: "escalate", reason: `unknown binary: ${binary}` };
}

/**
 * Decide a file-change approval: accept edits inside the workspace, escalate
 * anything that reaches outside it or touches .git/.
 */
export function decideFileChange(paths, workspaceRoot) {
  if (!paths.length) {
    return { decision: "escalate", reason: "file change with no resolvable paths" };
  }
  for (const filePath of paths) {
    const resolved = path.resolve(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { decision: "escalate", reason: `path outside workspace: ${filePath}` };
    }
    if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) {
      return { decision: "decline", reason: `direct .git modification: ${filePath}` };
    }
  }
  return { decision: "accept", reason: "all paths inside workspace" };
}

function approvalsDir(jobDir) {
  return path.join(jobDir, "approvals");
}

export function listPendingApprovals(jobDir) {
  const dir = approvalsDir(jobDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".request.json"))
    .map((name) => {
      const id = name.replace(/\.request\.json$/, "");
      const request = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const responseFile = path.join(dir, `${id}.response.json`);
      const response = fs.existsSync(responseFile) ? JSON.parse(fs.readFileSync(responseFile, "utf8")) : null;
      return { id, ...request, response };
    })
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
}

export function answerApproval(jobDir, approvalId, decision) {
  const dir = approvalsDir(jobDir);
  const requestFile = path.join(dir, `${approvalId}.request.json`);
  if (!fs.existsSync(requestFile)) {
    throw new Error(`No pending approval "${approvalId}" for this job.`);
  }
  fs.writeFileSync(
    path.join(dir, `${approvalId}.response.json`),
    `${JSON.stringify({ decision, answeredAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

async function escalate(jobDir, request, { timeoutMs, onEvent }) {
  const dir = approvalsDir(jobDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `apr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(
    path.join(dir, `${id}.request.json`),
    `${JSON.stringify({ ...request, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  onEvent?.({
    kind: "approval-escalated",
    approvalId: id,
    summary: request.summary,
    message: `Approval needed (${id}): ${request.summary}. Answer with: coder approve <job> ${id} [--deny]`
  });

  const responseFile = path.join(dir, `${id}.response.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      try {
        const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
        const decision = response.decision === "accept" ? "accept" : "decline";
        onEvent?.({ kind: "approval-answered", approvalId: id, decision });
        return decision;
      } catch {
        // Partially written response; retry on the next tick.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  onEvent?.({ kind: "approval-timeout", approvalId: id, message: `Approval ${id} timed out; declining.` });
  return "decline";
}

/**
 * Build the onApprovalRequest callback for a Codex run.
 *
 * mode:
 * - "auto": policy engine decides; ambiguous requests are escalated to
 *   pending-approval files and declined after escalationTimeoutMs.
 * - "deny": decline everything (Codex stays strictly inside its sandbox).
 */
export function createApprovalHandler({
  workspaceRoot,
  jobDir,
  mode = "auto",
  escalationTimeoutMs = 120_000,
  allowedNetworkHosts = [],
  onEvent = null
}) {
  return async (method, params, state) => {
    if (method === COMMAND_APPROVAL_METHOD) {
      const command = params.command ?? state?.itemIndex?.get(params.itemId)?.command ?? "";
      const summary = `run command: ${command || "(unknown command)"}${params.reason ? ` — ${params.reason}` : ""}`;

      if (mode === "deny") {
        onEvent?.({ kind: "approval-decision", method, decision: "decline", reason: "deny mode", summary });
        return { decision: "decline" };
      }

      const verdict = decideCommand(command, {
        networkHost: params.networkApprovalContext?.host ?? null,
        allowedNetworkHosts
      });
      onEvent?.({ kind: "approval-decision", method, decision: verdict.decision, reason: verdict.reason, summary });

      if (verdict.decision === "escalate") {
        const decision = await escalate(jobDir, { method, summary, command, params }, { timeoutMs: escalationTimeoutMs, onEvent });
        return { decision };
      }
      return { decision: verdict.decision };
    }

    if (method === FILE_CHANGE_APPROVAL_METHOD) {
      const item = state?.itemIndex?.get(params.itemId);
      const paths = (item?.changes ?? []).map((change) => change.path).filter(Boolean);
      const summary = `apply file changes: ${paths.join(", ") || "(unknown paths)"}${params.reason ? ` — ${params.reason}` : ""}`;

      if (mode === "deny") {
        onEvent?.({ kind: "approval-decision", method, decision: "decline", reason: "deny mode", summary });
        return { decision: "decline" };
      }

      const verdict = decideFileChange(paths, workspaceRoot);
      onEvent?.({ kind: "approval-decision", method, decision: verdict.decision, reason: verdict.reason, summary });

      if (verdict.decision === "escalate") {
        const decision = await escalate(jobDir, { method, summary, paths, params }, { timeoutMs: escalationTimeoutMs, onEvent });
        return { decision };
      }
      return { decision: verdict.decision };
    }

    // Unknown server request (permissions prompts, elicitations, ...): safest
    // generic answer is a JSON-RPC error, which Codex treats as a denial.
    onEvent?.({ kind: "approval-unsupported", method });
    throw new Error(`Coder does not handle server request ${method}; treating as denied.`);
  };
}
