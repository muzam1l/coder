import * as z from 'zod/mini';

/** Describes an arg for help, docs and MCP; `value` names a flag's value in help, such as `<dir>`. */
export function arg<T extends z.ZodMiniType>(schema: T, description = '', value?: string): T {
  z.globalRegistry.add(schema as z.ZodMiniType, { description, ...(value ? { value } : {}) });
  return schema;
}

export const flag = (description?: string) => arg(z.optional(z.boolean()), description);
export const str = (description?: string, value?: string) =>
  arg(z.optional(z.string()), description, value);
/** A repeatable value flag: `--add-dir a --add-dir b` collects `['a', 'b']`; as the last positional, the remaining words. */
export const strList = (description?: string, value?: string) =>
  arg(z.optional(z.array(z.string())), description, value);
/** A flag that may carry a value: bare `--server` is `true`, `--server <url>` the string. */
export const optStr = (description?: string, value?: string) =>
  arg(z.optional(z.union([z.string(), z.literal(true)])), description, value);
/** `--server` on a command that always talks to a server: absent means the default one. */
const serverOnly = (description?: string) =>
  arg(z._default(z.optional(z.union([z.string(), z.literal(true)])), true), description, '[url]');
/** --limit <n|all>: a positive integer, or 'all' for no cap (task list, flow list). */
export const limitOption = (description?: string) =>
  arg(
    z.optional(
      z.union([z.literal('all'), z.coerce.number().check(z.int(), z.positive())], {
        error: 'expected a positive integer or "all"',
      }),
    ),
    description,
    '<n|all>',
  );
/** --tail <n|all>: how much history to replay or include. */
export const tailOption = (description?: string) =>
  arg(
    z.optional(
      z.union([z.literal('all'), z.coerce.number().check(z.int(), z.nonnegative())], {
        error: 'expected a number or "all"',
      }),
    ),
    description,
    '<n|all>',
  );

export const serverOptions = {
  server: optStr('act on your Coder server', '[url]'),
  workspace: str('with --server: the workspace to act in (default: the saved one)', '<slug>'),
  yes: flag('with --server: connect to a server used for the first time without asking'),
};

/** The `--server` and `--workspace` flags a follow-up command repeats. */
export function serverSuffix(args: { server?: string | true; workspace?: string }) {
  return (
    (args.server === true
      ? ' --server'
      : typeof args.server === 'string'
        ? ` --server ${JSON.stringify(args.server)}`
        : '') + (args.workspace ? ` --workspace ${JSON.stringify(args.workspace)}` : '')
  );
}

export const credentialServerOptions = {
  server: serverOnly('act on your Coder server, in the saved workspace'),
  yes: flag('connect to a server used for the first time without asking'),
};

/** Why a `--match` regex is invalid, if it is. */
export function regexError(value: string): string | undefined {
  try {
    new RegExp(value);
    return undefined;
  } catch {
    return 'Not a valid regular expression.';
  }
}
