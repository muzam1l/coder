import * as z from 'zod/mini';

import { CoderError } from '../core/dispatch';

export interface ParsedArgs<T = Record<string, unknown>> {
  options: T;
  positionals: string[];
}

// Shared option shapes; zod schemas are immutable, so reusing instances is fine.
export const flag = z.optional(z.boolean());
export const str = z.optional(z.string());
/** A repeatable value flag: `--add-dir a --add-dir b` collects `['a', 'b']`. */
export const strList = z.optional(z.array(z.string()));
/** A flag that may carry a value: bare `--server` is `true`, `--server <url>` the string. */
export const optStr = z.optional(z.union([z.string(), z.literal(true)]));
/** `--server` on a command that always talks to a server: absent means the default one. */
export const serverOnly = z._default(optStr, true);
// Almost every command takes --cwd and --json.
export const baseOptions = { cwd: str, json: flag };
export const serverOptions = { server: optStr, workspace: str, yes: flag };
// --limit <n|all>: a positive integer, or 'all' for no cap (task list, flow list).
export const limitOption = z.optional(
  z.union([z.literal('all'), z.coerce.number().check(z.int(), z.positive())], {
    error: 'expected a positive integer or "all"',
  }),
);
// --tail <n|all>: how much history to replay or include.
export const tailOption = z.optional(
  z.union([z.literal('all'), z.coerce.number().check(z.int(), z.nonnegative())], {
    error: 'expected a number or "all"',
  }),
);

function optionDef(field: z.ZodMiniType): any {
  let def: any = field.def;
  while (def.innerType ?? def.in) def = (def.innerType ?? def.in).def;

  return def;
}

const isBooleanOption = (field: z.ZodMiniType) => optionDef(field).type === 'boolean';

export function parseArgs<S extends z.ZodMiniObject>(
  argv: string[],
  schema: S,
  settings: { positionals?: number; required?: string[]; command?: string } = {},
): ParsedArgs<z.output<S>> {
  const invalid = (message: string) =>
    new CoderError(
      'invalid-option',
      message,
      settings.command ? { hint: `Help: coder ${settings.command} --help` } : {},
    );
  const shape = schema.shape as unknown as Record<string, z.ZodMiniType>;
  const raw: Record<string, unknown> = {};
  const positionals: string[] = [];
  let passthrough = false;

  const setOption = (rawKey: string, key: string, value: string | undefined, short: boolean) => {
    const field = shape[key];
    const dash = short ? '-' : '--';
    if (!field) {
      throw invalid(
        `Unknown option ${dash}${rawKey} (use -- to pass literal text starting with -)`,
      );
    }
    if (isBooleanOption(field)) {
      raw[key] = value === undefined ? true : value !== 'false';
      return 0;
    }
    if (
      optionDef(field).type === 'union' &&
      optionDef(field).options.some((option: any) => option.def.type === 'literal') &&
      (value === undefined || value.startsWith('-'))
    ) {
      raw[key] = true;
      return 0;
    }
    if (value === undefined) {
      throw invalid(`Missing value for ${dash}${rawKey}`);
    }
    raw[key] =
      optionDef(field).type === 'array' ? [...((raw[key] as string[]) ?? []), value] : value;
    return 1;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    if (token.startsWith('--')) {
      const [key, inlineValue] = token.slice(2).split('=', 2);
      // A boolean flag consumes nothing; a value flag without an inline value
      // consumes the next token.
      if (inlineValue === undefined && shape[key] && !isBooleanOption(shape[key])) {
        index += setOption(key, key, argv[index + 1], false);
      } else {
        setOption(key, key, inlineValue, false);
      }
      continue;
    }

    const key = token.slice(1);
    if (shape[key] && !isBooleanOption(shape[key])) {
      index += setOption(key, key, argv[index + 1], true);
    } else {
      setOption(key, key, undefined, true);
    }
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const key = String(issue.path[0] ?? '');
    const value = raw[key];
    throw invalid(
      value === undefined
        ? `Missing required --${key}.`
        : `Invalid --${key} value ${JSON.stringify(value)}: ${issue.message}`,
    );
  }
  const missing = settings.required?.[positionals.length];
  if (missing) throw invalid(`Missing ${missing}.`);
  const maximum = settings.positionals ?? 0;
  if (positionals.length > maximum) {
    const extra = positionals.slice(maximum);
    throw new CoderError(
      'invalid-option',
      `Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`,
      settings.command ? { hint: `Help: coder ${settings.command} --help` } : {},
    );
  }
  return { options: result.data, positionals };
}
