/** Agent-written markdown as it is posted to a platform: replies, final messages, reviews and their inline comments. */
import type { Nodes } from 'chat';

/** Phrasing nodes, whose raw HTML is inline; elsewhere it is a block that becomes a paragraph. */
const INLINE = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell',
]);

/** One Slack special mention, such as `<!here>` or `<!subteam^S1|team>`, and nothing else. */
const SLACK_MENTION = /^<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^<>]*)?>$/;

/** The markdown with every image as its alt text and raw HTML as literal text, since both load content with no click; code stays, and unchanged text is returned as written. */
export async function postedMarkdown(text: string): Promise<string> {
  const { parseMarkdown, stringifyMarkdown, walkAst } = await import('chat');
  const ast = parseMarkdown(text);
  let changed = false;
  const literal = (node: Nodes, inline: boolean): Nodes => {
    if (node.type !== 'image' && node.type !== 'imageReference' && node.type !== 'html')
      return node;
    // Slack writes its broadcast and group mentions this way.
    if (node.type === 'html' && SLACK_MENTION.test(node.value)) return node;
    changed = true;
    // A zero-width space after `<` keeps the tag as text on every platform.
    const value = node.type === 'html' ? node.value.replace(/</g, '<\u200b') : (node.alt ?? '');

    return inline
      ? { type: 'text', value }
      : { type: 'paragraph', children: [{ type: 'text', value }] };
  };
  const visit = <T extends Nodes>(node: T): T => {
    if ('children' in node)
      node.children = node.children.map(child => literal(child, INLINE.has(node.type))) as never;

    return node;
  };
  walkAst(visit(ast), visit);

  return changed ? stringifyMarkdown(ast, { bullet: '-' }).trimEnd() : text;
}
