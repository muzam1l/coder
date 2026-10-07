/** `coder docs`: the bundled documentation topics and their pages. */
import fs from 'node:fs';
import path from 'node:path';

import { CoderError } from './dispatch';
import { resolveMarketplaceDir } from './runtime';

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

// Every docs/*.md by basename plus one level of docs/<dir>/ (index.md is the
// folder topic, its siblings are `<dir>/<name>`), then the specials.
function collectTopics(root: string): Topic[] {
  const docsDir = path.join(root, 'docs');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(docsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const topic = (name: string, file: string): Topic => ({
    name,
    file,
    description: describeDoc(path.join(root, file)),
  });
  const names = [
    ...new Set(
      entries
        .filter(e =>
          e.isDirectory() ? hasIndex(path.join(docsDir, e.name)) : e.name.endsWith('.md'),
        )
        .map(e => (e.isDirectory() ? e.name : path.basename(e.name, '.md'))),
    ),
  ].sort();
  const docTopics: Topic[] = [];
  for (const name of names) {
    const dir = path.join(docsDir, name);
    if (!entries.some(e => e.isDirectory() && e.name === name)) {
      docTopics.push(topic(name, path.join('docs', `${name}.md`)));
      continue;
    }
    docTopics.push(topic(name, path.join('docs', name, 'index.md')));
    const pages = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== 'index.md')
      .sort();
    for (const page of pages) {
      const sub = path.basename(page, '.md');
      docTopics.push(topic(`${name}/${sub}`, path.join('docs', name, page)));
    }
  }
  const specials: Topic[] = SPECIAL_TOPICS.map(s => ({
    name: s.name,
    file: s.file,
    description: s.description,
  }));
  return [...docTopics, ...specials];
}

function hasIndex(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'index.md'));
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
  opts: { claude?: boolean } = {},
): { topics: { name: string; description: string }[] } | { name: string; content: string } {
  const root = resolveMarketplaceDir();
  const topics = collectTopics(root);
  if (!topic) {
    return { topics: topics.map(t => ({ name: t.name, description: t.description })) };
  }
  // Case-insensitive; a sub-topic also answers to `<dir>-<name>`.
  const key = topic.toLowerCase();
  let match = topics.find(t => {
    const name = t.name.toLowerCase();
    return name === key || name.replace('/', '-') === key;
  });
  // `docs skill --claude`: the Claude Code flavor of the host skill.
  if (match?.name === 'skill' && opts.claude) {
    match = { ...match, file: 'plugins/claude/skills/dispatch/SKILL.md' };
  }
  if (!match) {
    throw new CoderError(
      'invalid-option',
      `Unknown docs topic "${topic}". Available: ${topics.map(t => t.name).join(', ')}`,
      { hint: 'List topics: coder docs' },
    );
  }
  const absPath = path.join(root, match.file);
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    throw new CoderError(
      'invalid-option',
      `Could not read docs for "${match.name}" (${match.file}).`,
    );
  }
  return { name: match.name, content };
}
