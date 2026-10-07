import { MemoryCache } from '../context/cache';
import { type Params } from '../routes/match';
import { type Found } from '../../client/types';
import { type ServerContext } from '../context';
import { type CoderConfig } from '../../core/config';
import { ConfigError, shownConfig, body, change } from './config';
import { json } from '../routes/http';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export async function listMcp(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return json((await shownConfig(ctx)).mcp ?? {});
}

export async function createMcp(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const { name: added = '', ...entry } = await body<
    {
      name?: string;
    } & NonNullable<CoderConfig['mcp']>[string]
  >(req);
  if (!SLUG.test(added)) return json({ error: `Invalid server name "${added}"` }, 400);

  return change(ctx, config => {
    config.mcp = { ...config.mcp, [added]: entry };
  });
}

export async function deleteMcp(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const name = params.name!;

  return change(ctx, config => {
    if (!config.mcp?.[name]) throw new ConfigError(`No MCP server "${name}"`);
    delete config.mcp[name];
  });
}

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers';

const RUNNERS: Record<string, [string, ...string[]]> = {
  npm: ['npx', '-y'],
  pypi: ['uvx'],
  oci: ['docker', 'run', '-i', '--rm'],
};

type Input = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
  default?: string;
};

type Argument = Partial<Input> & {
  type: string;
  valueHint?: string;
  variables?: Record<string, Omit<Input, 'name'>>;
};

type ArgumentInput = {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
};

type Remote = { type: string; url: string; headers?: Input[] };

type Package = {
  registryType: string;
  identifier: string;
  runtimeHint?: string;
  transport?: { type: string };
  environmentVariables?: Input[];
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
};

type Detail = {
  name: string;
  title?: string;
  description?: string;
  remotes?: Remote[];
  packages?: Package[];
};

const inputs = (list: Input[] = []) =>
  list.map(({ name, description, isRequired, isSecret, value, default: fallback }) => ({
    name,
    ...(description ? { description } : {}),
    ...((value ?? fallback) ? { placeholder: value ?? fallback } : {}),
    required: isRequired === true,
    secret: isSecret === true,
  }));

function argumentsOf(list: Argument[] = [], kind: string, fields: ArgumentInput[]): string[] {
  return list.flatMap((argument, index) => {
    const key = `${kind}:${index}`;
    const variables = Object.entries(argument.variables ?? {});
    let value = argument.value ?? argument.default;
    const field = (name: string, label: string, input: Omit<Input, 'name'>) => {
      const [mapped] = inputs([{ ...input, name }]);
      fields.push({ ...mapped!, label });
      return `{${name}}`;
    };
    if (variables.length)
      for (const [name, input] of variables)
        value = value?.replaceAll(`{${name}}`, field(`${key}:${name}`, name, input));
    else if (value === undefined && (argument.valueHint || argument.isRequired))
      value = field(key, argument.valueHint ?? argument.name ?? key, argument);
    return [
      ...(argument.type === 'named' && argument.name ? [argument.name] : []),
      ...(value === undefined ? [] : [value]),
    ];
  });
}

function entryOf(server: Detail) {
  const remote = server.remotes?.find(
    each => each.type === 'streamable-http' || each.type === 'sse',
  );
  if (remote)
    return {
      type: remote.type === 'sse' ? 'sse' : 'http',
      url: remote.url,
      env: [],
      headers: inputs(remote.headers),
    };
  const pkg = server.packages?.find(
    each => RUNNERS[each.registryType] && (each.transport?.type ?? 'stdio') === 'stdio',
  );
  if (!pkg) return undefined;
  const [command, ...args] = RUNNERS[pkg.registryType]!;
  const argumentInputs: ArgumentInput[] = [];
  const runtime = argumentsOf(pkg.runtimeArguments, 'runtime', argumentInputs);
  const binary = argumentsOf(pkg.packageArguments, 'package', argumentInputs);
  return {
    type: 'stdio',
    command: pkg.runtimeHint ?? command,
    args: [
      ...(!pkg.runtimeHint || pkg.runtimeHint === command ? args : []),
      ...runtime,
      pkg.identifier,
      ...binary,
    ],
    ...(argumentInputs.length ? { argumentInputs } : {}),
    env: inputs(pkg.environmentVariables),
    headers: [],
  };
}

export async function mcpRegistry(req: Request, ctx: ServerContext, url: URL): Promise<Response> {
  const search = url.searchParams.get('q')?.trim() ?? '';
  const settings = (ctx.settings ??= {});
  const cache = (settings.registry ??= new MemoryCache<Found[]>({
    ttlMs: 600_000,
    max: 100,
    now: ctx.now,
  }));
  const found = await cache.get(search, () => registrySearch(ctx, search));
  if (found) return json(found);
  return json({ error: 'The MCP registry did not answer. Try again.' }, 502);
}

async function registrySearch(ctx: ServerContext, search: string): Promise<Found[] | undefined> {
  const query = new URLSearchParams({ version: 'latest', limit: '30' });
  if (search) query.set('search', search);
  try {
    const response = await (ctx.fetch ?? fetch)(`${REGISTRY}?${query}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    const { servers = [] } = (await response.json()) as { servers?: Array<{ server: Detail }> };
    return servers.flatMap(({ server }) => {
      const entry = entryOf(server);
      return entry
        ? [
            {
              name: server.name,
              title: server.title ?? server.name.split('/').pop() ?? server.name,
              description: server.description ?? '',
              ...entry,
            },
          ]
        : [];
    });
  } catch {
    return undefined;
  }
}
