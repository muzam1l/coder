export const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Throws on input that is not base64url JSON. */
export const decodeJson = <T>(value: string): T =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
