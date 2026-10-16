import type { AgentEvent, McpServerSpec, Preset } from '../types';

export const GITHUB_PRESETS: Record<Preset, string[]> = {
  read: ['read'],
  write: ['read', 'write'],
};

/** The latest release binary of github/github-mcp-server into /usr/local/bin. */
export const GITHUB_MCP_SERVER_INSTALL =
  'arch=$(uname -m); [ "$arch" = aarch64 ] && arch=arm64; curl -fsSL "https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_$arch.tar.gz" | tar -xz -C /usr/local/bin github-mcp-server';

/** GitHub's official MCP server (github/github-mcp-server) on the task's narrowed installation token. */
export function githubToolServer(
  tools: string[],
  _event: AgentEvent | undefined,
  token: string,
): McpServerSpec {
  const readOnly = !tools.includes('write');
  return {
    name: 'github',
    command: 'github-mcp-server',
    args: [
      'stdio',
      '--toolsets=all',
      ...(readOnly ? ['--read-only'] : []),
    ],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
  };
}
