/** Server URLs and Server-Sent Events parsing, free of dependencies so the dashboard imports it. */
import { CoderError } from '../core/errors';

export function isLoopbackServer(server: string): boolean {
  try {
    const host = new URL(server).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoderError(
      'invalid-option',
      'Give the server as a URL, e.g. https://agents.example.com.',
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackServer(url.origin)))
    throw new CoderError(
      'invalid-option',
      'Coder servers require HTTPS unless they are loopback.',
      { hint: 'Use https://, or http://localhost for a local server.' },
    );
  if (url.username || url.password || url.search || url.hash)
    throw new CoderError(
      'invalid-option',
      'The server must be an origin without credentials, query, or fragment.',
    );
  return url.toString().replace(/\/+$/, '');
}

export const queryPath = (path: string, options: object) => {
  const query = new URLSearchParams();
  if ('cursor' in options && typeof options.cursor === 'string')
    query.set('cursor', options.cursor);
  for (const [key, value] of Object.entries(options))
    if (key !== 'cursor' && value !== undefined && value !== false && value !== '')
      query.set(key, value === true ? '1' : Array.isArray(value) ? value.join(',') : String(value));
  return `${path}?${query}`;
};

/** Server-Sent Events from a response body, one `{ event, data }` per message. */
export async function* serverEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
        else if (line.startsWith('id: ')) id = line.slice(4);
      }
      if (data.length || id) yield { event, data: data.join('\n'), ...(id ? { id } : {}) };
    }
  }
}
