/** The event JSON in task prompts, free of dependencies so the dashboard imports it. */
type EventAuthor = { id: string; handle?: string; name?: string; url?: string };

type EventMessageJson = { id?: string; text?: string; author: EventAuthor; url?: string };

/** A change nobody wrote, with its actor as `by`. */
type EventChangeJson = {
  event?: string;
  action?: string;
  title?: string;
  by?: EventAuthor;
  url?: string;
  payload?: unknown;
};

type EventJson = EventChangeJson & {
  mustReply?: boolean;
  message?: EventMessageJson;
  messages?: Array<EventMessageJson | (EventChangeJson & { id?: undefined })>;
  reactions?: Array<{ emoji: string; by: string[] }>;
};

export const unxml = (text: string) =>
  text.replace(
    /&(amp|lt|gt);/g,
    (_, name: 'amp' | 'lt' | 'gt') => ({ amp: '&', lt: '<', gt: '>' })[name],
  );

/** Read event JSON, optionally alongside a turn's history or other text. */
export function eventJsons(prompt = '', embedded = false): EventJson[] | undefined {
  const event = /<event>\n([^]*?)\n<\/event>/g;
  if (!embedded && (!prompt.trimStart().startsWith('<event>') || prompt.replace(event, '').trim()))
    return;
  const events: EventJson[] = [];
  for (const [, body] of prompt.matchAll(event)) {
    try {
      const json = JSON.parse(unxml(body!));
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        if (!embedded) return;
        continue;
      }
      events.push(json);
    } catch (error) {
      console.error('coder: unreadable event prompt', error);
      if (!embedded) return;
    }
  }

  return events.length ? events : undefined;
}

/** Any event in a turn or its live steers can require a reply. */
export function replyRequired(
  prompt?: string | null,
  fallback?: boolean,
  steers: string[] = [],
): boolean | undefined {
  const asks = [prompt ?? '', ...steers].flatMap(text =>
    (eventJsons(text, true) ?? []).flatMap(json =>
      typeof json.mustReply === 'boolean' ? [json.mustReply] : [],
    ),
  );

  return asks.length ? asks.includes(true) : fallback;
}
