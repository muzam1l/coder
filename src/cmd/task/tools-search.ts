import { command } from '../../cli';

/** A turn's tool search over stdio. */
export const commandToolsSearch = command({
  name: 'tools-search',
  description: "serve a turn's tool search over stdio",
  access: 'write',
  globalFlags: { json: false, cwd: false },
  mcp: false,
  async run() {
    const { serveToolSearch } = await import('../../core/tool-search');
    const { serverCredential } = await import('../../core/task/mcp');

    await serveToolSearch({
      credential: endpoint => serverCredential(endpoint),
      localCredential: async (spec, refused) => {
        const { localConnectionToken } = await import('../../core/connections');
        return localConnectionToken(spec.connection ?? spec.name, refused);
      },
    });
  },
});
