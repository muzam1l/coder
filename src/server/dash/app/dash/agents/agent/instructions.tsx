'use client';

import './instructions.css';

import { h, type ComponentChildren } from 'preact';

import { Collapse } from '@/comps/ui/collapse';

const INLINE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|\*(\S(?:.*?\S)?)\*|(?<!\w)_(\S(?:.*?\S)?)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const SAFE_HREF = /^(?:https?:|mailto:)/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/;
const BLOCK = /^\s*(?:#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s)/;

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [all, code, bold, bold2, em, em2, label, href] = match;
    if (match.index > at) out.push(text.slice(at, match.index));
    if (code) out.push(<code>{code}</code>);
    else if (bold || bold2) out.push(<strong>{inline(bold || bold2!)}</strong>);
    else if (em || em2) out.push(<em>{inline(em || em2!)}</em>);
    else if (SAFE_HREF.test(href!))
      out.push(
        <a class="link" href={href} target="_blank" rel="noopener noreferrer">
          {inline(label!)}
        </a>,
      );
    else out.push(...inline(label!));
    at = match.index + all.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Minimal markdown as Preact nodes, so raw HTML in the text stays text. */
export function markdown(text: string) {
  const lines = text.split(/\r?\n/);
  const blocks: ComponentChildren[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);
    const item = ITEM.exec(line);
    if (fence) {
      const end = lines.findIndex((next, j) => j > i && next.trim().startsWith(fence[1]!));
      const stop = end < 0 ? lines.length : end;
      blocks.push(
        <pre>
          <code>{lines.slice(i + 1, stop).join('\n')}</code>
        </pre>,
      );
      i = stop + 1;
    } else if (heading) {
      blocks.push(h(`h${Math.min(heading[1]!.length + 2, 6)}`, null, inline(heading[2]!)));
      i++;
    } else if (item) {
      const ordered = !item[1];
      const items: ComponentChildren[] = [];
      for (let next; (next = ITEM.exec(lines[i] ?? '')) && !next[1] === ordered; i++)
        items.push(<li>{inline(next[2]!)}</li>);
      blocks.push(ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
    } else if (!line.trim()) i++;
    else {
      const para: ComponentChildren[] = [];
      for (; lines[i]?.trim() && (!para.length || !BLOCK.test(lines[i]!)); i++) {
        if (para.length) para.push(<br />);
        para.push(...inline(lines[i]!));
      }
      blocks.push(<p>{para}</p>);
    }
  }
  return blocks;
}

/** An agent's instructions as markdown, collapsed with a Show more toggle when long. */
export function Instructions({ text }: { text: string }) {
  return <Collapse class="body md">{markdown(text)}</Collapse>;
}
