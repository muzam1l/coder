import { command } from '../../cli';

/** A turn's tool search over stdio. */
export const commandToolsSearch = command({
  name: 'tools-search',
  description: "serve a turn's tool search over stdio",
  access: 'write',
  globalFlags: { json: false, cwd: false },
  mcp: false,
  async run() {
    const { searchApp, searchServers, TOOL_SEARCH_ENV } =
      await import('../../core/task/context/tools');
    const { serve } = await import('contextjsx/serve');

    await (
      await serve(searchApp(searchServers(process.env[TOOL_SEARCH_ENV])), 'stdio')
    ).done;
  },
});
