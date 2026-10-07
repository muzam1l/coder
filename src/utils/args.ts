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

// A flag takes no value iff its schema unwraps to a boolean.
function isOptionalValueOption(field: z.ZodMiniType): boolean {
  let def: any = (field as any).def;
  while (def) {
    if (def.type === 'union')
      return def.options.some((option: any) => option.def.type === 'literal');
    const inner = def.innerType ?? def.in;
    def = inner ? inner.def : undefined;
  }
  return false;
}

function unwrapsTo(field: z.ZodMiniType, type: string): boolean {
  let def: any = (field as any).def;
  while (def) {
    if (def.type === type) return true;
    const inner = def.innerType ?? def.in;
    def = inner ? inner.def : undefined;
  }
  return false;
}

const isBooleanOption = (field: z.ZodMiniType) => unwrapsTo(field, 'boolean');

export function parseArgs<S extends z.ZodMiniObject>(
  argv: string[],
  schema: S,
  settings: { positionals?: number; command?: string } = {},
): ParsedArgs<z.output<S>> {
  const shape = schema.shape as unknown as Record<string, z.ZodMiniType>;
  const raw: Record<string, unknown> = {};
  const positionals: string[] = [];
  let passthrough = false;

  const setOption = (rawKey: string, key: string, value: string | undefined, short: boolean) => {
    const field = shape[key];
    const dash = short ? '-' : '--';
    if (!field) {
      throw new Error(
        `Unknown option ${dash}${rawKey} (use -- to pass literal text starting with -)`,
      );
    }
    if (isBooleanOption(field)) {
      raw[key] = value === undefined ? true : value !== 'false';
      return 0;
    }
    if (isOptionalValueOption(field) && (value === undefined || value.startsWith('-'))) {
      raw[key] = true;
      return 0;
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${dash}${rawKey}`);
    }
    raw[key] = unwrapsTo(field, 'array') ? [...((raw[key] as string[]) ?? []), value] : value;
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
    throw new Error(
      value === undefined
        ? `Missing required --${key}.`
        : `Invalid --${key} value ${JSON.stringify(value)}: ${issue.message}`,
    );
  }
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
