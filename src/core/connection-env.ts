/** Connection secrets a task receives in its environment, and their redaction from what it writes. */
export function connectionEnvName(name: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/.test(name) &&
    !/^(CODER_|CODEX_|LD_|DYLD_|GIT_|APP_TOKEN(?:_|$))/.test(name) &&
    ![
      'PATH',
      'HOME',
      'SHELL',
      'USER',
      'PWD',
      'TMPDIR',
      'NODE_OPTIONS',
      'NODE_PATH',
      'BASH_ENV',
      'ENV',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_AUTH_JSON',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'OPENAI_BASE_URL',
      'ANTHROPIC_BASE_URL',
    ].includes(name)
  );
}

export function injectedConnectionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const values = JSON.parse(env.CODER_CONNECTION_ENV_VALUES ?? '{}') as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        connectionEnvName(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}

export function transportedConnectionSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => /^CODER_CONNECTION_[A-F0-9]{24}$/.test(key) && value)
    .flatMap(([, value]) => [value!, ...(value!.startsWith('Bearer ') ? [value!.slice(7)] : [])]);
}

export function redactConnectionSecrets(value: unknown, additional: string[] = []): string {
  const named = Object.entries(injectedConnectionEnvironment())
    .filter(([, secret]) => secret.length >= 8)
    .map(([name, secret]) => [secret, `[${name}]`] as const);
  const secrets = [...additional, ...transportedConnectionSecrets()]
    .filter(Boolean)
    .map(secret => [secret, '[REDACTED]'] as const);
  const replacements = [...named, ...secrets].sort(([left], [right]) => right.length - left.length);

  return JSON.stringify(value, (_key, entry) =>
    typeof entry === 'string'
      ? replacements.reduce(
          (text, [secret, replacement]) => text.replaceAll(secret, replacement),
          entry,
        )
      : entry,
  );
}
