import type { McpServerSpec } from '../../core/types';
import type { AgentEvent, Preset } from '../../agent/types';

/** Access levels of GitHub's MCP server; the narrowed token enforces them. */
export const GITHUB_PRESETS: Record<Preset, string[]> = {
  observe: ['read'],
  comment: ['read', 'comment'],
  write: ['read', 'comment', 'write'],
};

const PULL_TOOLSETS = ['repos', 'pull_requests', 'issues'];
const ISSUE_TOOLSETS = ['repos', 'issues'];

/** Toolsets of GitHub's MCP server for the event that started the task. */
function githubToolsets(event?: AgentEvent): string[] {
  return event?.type === 'pull_request' ||
    /^github:[^:]+:\d+(:|$)/.test(event?.chat?.thread.id ?? '')
    ? PULL_TOOLSETS
    : ISSUE_TOOLSETS;
}

/** The latest release binary of github/github-mcp-server into /usr/local/bin. */
export const GITHUB_MCP_SERVER_INSTALL =
  'arch=$(uname -m); [ "$arch" = aarch64 ] && arch=arm64; curl -fsSL "https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_$arch.tar.gz" | tar -xz -C /usr/local/bin github-mcp-server';

/** GitHub's official MCP server (github/github-mcp-server) on the task's narrowed installation token. */
export function githubToolServer(
  tools: string[],
  event: AgentEvent | undefined,
  token: string,
): McpServerSpec {
  const readOnly = !tools.some(tool => tool !== 'read');
  return {
    name: 'github',
    command: 'github-mcp-server',
    args: [
      'stdio',
      `--toolsets=${githubToolsets(event).join(',')}`,
      ...(readOnly ? ['--read-only'] : []),
    ],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
  };
}
