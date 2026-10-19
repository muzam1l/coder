/** `coder docs [topic]`: list bundled docs, or print one's raw markdown. */
import process from 'node:process';

import { outStyle, renderTable } from '../tui/output';
import { flag, str } from '../utils/args';
import { command, nextSteps } from '../cli';

export const commandDocs = command({
  name: 'docs',
  description: 'print bundled documentation (for agents to read)',
  usage:
    "Print bundled documentation. With no topic, list the available topics; with a\ntopic, print that doc's raw markdown to stdout (unstyled, for an agent to\nconsume). Topics with sub-pages list them as `<topic>/<page>` (also accepted as\n`<topic>-<page>`). `coder docs skill` prints the host skill so an engine can\nload it once per session (--claude for the Claude Code flavor).",
  access: 'read',
  args: {
    topic: str('the doc to print (default: list the topics)'),
    claude: flag('with the skill topic: print the Claude Code flavor'),
  },
  globalFlags: { cwd: false },
  cli: {
    positional: ['topic'],
    examples: [
      'coder docs  # list the available topics',
      'coder docs flows  # print the Flows doc',
      'coder docs review  # print the Review doc',
    ],
  },
  run: async ({ options, args: [topic] }) => {
    const { docsCore } = await import('../core/docs');
    return docsCore(topic, options);
  },
  next: ({ result }) =>
    'content' in result ? [] : nextSteps(['Read a topic: coder docs <topic>']),
  print: data =>
    process.stdout.write(
      'content' in data
        ? data.content.endsWith('\n')
          ? data.content
          : `${data.content}\n`
        : renderDocsTopics(data.topics),
    ),
});

/** `coder docs`: the topic table; sub-topics indent under their folder. */
function renderDocsTopics(topics: { name: string; description: string }[]): string {
  const s = outStyle;
  const label = (name: string) => (name.includes('/') ? `  ${name}` : name);
  return renderTable(
    [
      { header: 'topic', value: t => label(t.name), paint: c => s.cyan(c) },
      { header: 'about', value: t => t.description, paint: c => s.light(c) },
    ],
    topics,
    s,
  );
}
