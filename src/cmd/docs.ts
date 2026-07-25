/** `coder docs [topic]` - list bundled docs, or print one's raw markdown. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { parseArgs, flag } from '../lib/args.js';
import { resolveMarketplaceDir } from '../lib/runtime.js';
import { fail, formatHints, outStyle, printJson } from '../lib/ui.js';

// Special topics that don't live under docs/, with a fixed description.
const SPECIAL_TOPICS: { name: string; file: string; description: string }[] = [
  {
    name: 'readme',
    file: 'README.md',
    description: 'What Coder is and how to get started.',
  },
  {
    name: 'skill',
    file: 'plugins/agents/skills/coder/SKILL.md',
    description: 'How a host agent should drive Coder.',
  },
];

interface Topic {
  name: string;
  file: string; // relative to the package root
  description: string;
}

// Every docs/*.md by basename, then the specials, in listing order.
function collectTopics(root: string): Topic[] {
  const docsDir = path.join(root, 'docs');
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(docsDir)
      .filter(name => name.endsWith('.md'))
      .sort();
  } catch {
    entries = [];
  }
  const docTopics: Topic[] = entries.map(name => {
    const file = path.join('docs', name);
    return {
      name: path.basename(name, '.md'),
      file,
      description: describeDoc(path.join(root, file)),
    };
  });
  const specials: Topic[] = SPECIAL_TOPICS.map(s => ({
    name: s.name,
    file: s.file,
    description: s.description,
  }));
  return [...docTopics, ...specials];
}

// One-line description from a doc: its first heading joined with the first
// sentence of its first paragraph. Robust to missing pieces.
function describeDoc(absPath: string): string {
  let text = '';
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split('\n');
  let heading = '';
  let paragraph = '';
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '') {
      continue;
    }
    if (line.startsWith('#')) {
      if (!heading) {
        heading = line.replace(/^#+\s*/, '');
      }
      continue;
    }
    // First non-blank, non-heading, non-fence line: the opening paragraph.
    paragraph = line;
    break;
  }
  return firstSentence(paragraph) || heading;
}

function firstSentence(paragraph: string): string {
  if (!paragraph) return '';
  const match = paragraph.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : paragraph).trim();
}

// Print-free core: no topic lists the topics; a topic returns its raw markdown.
export function docsCore(
  topic?: string,
): { topics: { name: string; description: string }[] } | { name: string; content: string } {
  const root = resolveMarketplaceDir();
  const topics = collectTopics(root);
  if (!topic) {
    return { topics: topics.map(t => ({ name: t.name, description: t.description })) };
  }
  const match = topics.find(t => t.name === topic.toLowerCase());
  if (!match) {
    throw new Error(`Unknown docs topic "${topic}". Available: ${topics.map(t => t.name).join(', ')}`);
  }
  const absPath = path.join(root, match.file);
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    throw new Error(`Could not read docs for "${match.name}" (${match.file}).`);
  }
  return { name: match.name, content };
}

export async function commandDocs(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, z.object({ json: flag }));
  const [topic] = positionals;

  let data: ReturnType<typeof docsCore>;
  try {
    data = docsCore(topic);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only the unknown-topic error carries a next-step hint; read failures don't.
    return fail(message, message.startsWith('Unknown docs topic') ? { hint: 'List topics: coder docs' } : {});
  }

  // A single topic: print its raw markdown.
  if ('content' in data) {
    process.stdout.write(data.content.endsWith('\n') ? data.content : `${data.content}\n`);
    return;
  }

  // No topic: list what's available.
  if (options.json) {
    printJson(data);
    return;
  }
  const s = outStyle;
  const width = Math.max(0, ...data.topics.map(t => t.name.length));
  const rows = data.topics.map(t => `  ${s.cyan(t.name.padEnd(width))}  ${s.dim(t.description)}`);
  process.stdout.write(
    [s.bold('Docs:'), ...rows, '', formatHints(['Read a topic: coder docs <topic>'], s)].join('\n') +
      '\n',
  );
}
