import type { ToolServer, Preset } from '../types';

export const LINEAR_PRESETS: Record<Preset, string[]> = {
  read: ['read'],
  write: ['read', 'write'],
};

export function linearToolServer(tools: string[], _event: unknown, token: string): ToolServer {
  return {
    name: 'linear',
    url: `https://mcp.linear.app/mcp${tools.includes('write') ? '' : '/readonly'}`,
    headers: { Authorization: `Bearer ${token}` },
    credentialFields: { header: 'Authorization' },
  };
}
