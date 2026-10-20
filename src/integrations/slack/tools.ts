import { randomUUID } from 'node:crypto';
import type { PlatformEvent, ToolServer, Preset } from '../types';

export const SLACK_PRESETS: Record<Preset, string[]> = {
  read: ['read'],
  write: ['read', 'write'],
};

export const SLACK_MCP_SERVER_INSTALL =
  'set -eu; arch=$(uname -m); case "$arch" in x86_64) arch=amd64; checksum=d1525962e9b9dbfdd2eaf48d0a81ca1eca7d8f1862b8d34931b812c850b3e568;; aarch64|arm64) arch=arm64; checksum=a307a48d16c2261346bdc257274cdcdb8b2027c867dc971b41d52cef36472c88;; *) exit 1;; esac; file=$(mktemp); trap \'rm -f "$file"\' EXIT; curl -fsSL "https://github.com/korotovsky/slack-mcp-server/releases/download/v1.3.0/slack-mcp-server-linux-$arch" -o "$file"; echo "$checksum  $file" | sha256sum -c -; install -m 755 "$file" /usr/local/bin/slack-mcp-server';

export function slackToolServer(
  tools: string[],
  _event: PlatformEvent | undefined,
  token: string,
): ToolServer {
  const readOnly = !tools.includes('write');
  const cache = `/tmp/coder-slack-${randomUUID()}`;

  return {
    name: 'slack',
    command: 'slack-mcp-server',
    readOnly,
    args: ['--transport', 'stdio'],
    env: {
      SLACK_MCP_XOXB_TOKEN: token,
      SLACK_MCP_USERS_CACHE: `${cache}-users.json`,
      SLACK_MCP_CHANNELS_CACHE: `${cache}-channels.json`,
      SLACK_MCP_LOG_LEVEL: 'error',
      SLACK_MCP_ADD_MESSAGE_TOOL: readOnly ? '' : 'true',
      SLACK_MCP_REACTION_TOOL: readOnly ? '' : 'true',
      SLACK_MCP_ATTACHMENT_TOOL: 'true',
      SLACK_MCP_MARK_TOOL: readOnly ? '' : 'true',
    },
    credentialFields: { env: 'SLACK_MCP_XOXB_TOKEN' },
  };
}
