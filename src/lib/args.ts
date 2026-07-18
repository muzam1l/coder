import * as z from "zod/mini";

export interface ParsedArgs<T = Record<string, unknown>> {
  options: T;
  positionals: string[];
}

// Shared option shapes; zod schemas are immutable, so reusing instances is fine.
export const flag = z.optional(z.boolean());
export const str = z.optional(z.string());
// Almost every command takes --cwd and --json.
export const baseOptions = { cwd: str, json: flag };

// A flag takes no value iff its schema unwraps to a boolean.
function isBooleanOption(field: z.ZodMiniType): boolean {
  let def: any = (field as any).def;
  while (def) {
    if (def.type === "boolean") return true;
    const inner = def.innerType ?? def.in;
    def = inner ? inner.def : undefined;
  }
  return false;
}

export function parseArgs<S extends z.ZodMiniObject>(
  argv: string[],
  schema: S,
): ParsedArgs<z.output<S>> {
  const shape = schema.shape as unknown as Record<string, z.ZodMiniType>;
  const raw: Record<string, unknown> = {};
  const positionals: string[] = [];
  let passthrough = false;

  const setOption = (rawKey: string, key: string, value: string | undefined, short: boolean) => {
    const field = shape[key];
    const dash = short ? "-" : "--";
    if (!field) {
      throw new Error(`Unknown option ${dash}${rawKey} (use -- to pass literal text starting with -)`);
    }
    if (isBooleanOption(field)) {
      raw[key] = value === undefined ? true : value !== "false";
      return 0;
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${dash}${rawKey}`);
    }
    raw[key] = value;
    return 1;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [key, inlineValue] = token.slice(2).split("=", 2);
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
    const key = String(issue.path[0] ?? "");
    const value = raw[key];
    throw new Error(
      value === undefined
        ? `Missing required --${key}.`
        : `Invalid --${key} value ${JSON.stringify(value)}: ${issue.message}`,
    );
  }
  return { options: result.data, positionals };
}

export function splitRawArgumentString(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
