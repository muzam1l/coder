import { connect, type ServerOptions } from '../core/remote';
import { CoderError } from '../core/errors';
import type { RunnerInput, RunnerUpdate } from '../client/types';

export const listRunners = (options: ServerOptions = {}) => connect(options).runners.list();
export const addRunner = (input: RunnerInput, options: ServerOptions = {}) =>
  connect(options).runners.add(input);
export const pairRunner = (
  input: { name?: string; scope: RunnerInput['scope'] },
  options: ServerOptions = {},
) => connect(options).runners.pair(input);
export const updateRunner = (id: string, input: RunnerUpdate, options: ServerOptions = {}) =>
  connect(options).runners.update(id, input);
export const testRunner = (id: string, options: ServerOptions = {}) =>
  connect(options).runners.test(id);
export const removeRunner = (id: string, options: ServerOptions = {}) =>
  connect(options).runners.remove(id);

export async function addRunnerFields(
  kind: string,
  options: ServerOptions & { name?: string; scope?: string; field?: string[] },
) {
  const api = connect(options);
  const { catalog } = await api.runners.list();
  const spec = catalog.find(spec => spec.kind === kind);
  if (!spec) throw new CoderError('invalid-option', 'Unknown runner kind.');
  if (!spec.available) throw new CoderError('invalid-option', spec.reason ?? 'Runner unavailable.');
  const config: Record<string, string> = {};
  for (const field of options.field ?? []) {
    const at = field.indexOf('=');
    if (at < 1) throw new CoderError('invalid-option', 'Use --field key=value.');
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    const definition = spec.fields.find(field => field.key === key);
    if (!definition) throw new CoderError('invalid-option', `Unknown runner field ${key}.`);
    if (definition.secret) {
      if (!/^env:[A-Z_][A-Z0-9_]*$/.test(value) || !process.env[value.slice(4)])
        throw new CoderError(
          'invalid-option',
          `Read ${key} from the environment with --field ${key}=env:VARIABLE.`,
        );
      config[key] = process.env[value.slice(4)]!;
    } else config[key] = value;
  }
  const scope = options.scope ?? ((await api.me()).user ? 'personal' : 'workspace');
  if (scope !== 'personal' && scope !== 'workspace')
    throw new CoderError('invalid-option', 'Scope must be personal or workspace.');
  if (spec.connect === 'pair') return api.runners.pair({ name: options.name, scope });
  return api.runners.add({ kind: spec.kind, name: options.name ?? spec.name, scope, config });
}
