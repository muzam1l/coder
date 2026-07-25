/** Journal read/write + input fingerprinting. See docs/flows.md "Resume". */
import crypto from 'node:crypto';
import fs from 'node:fs';

import type { JournalEntry } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export function fingerprint(kind: string, payload: unknown): string {
  return crypto.createHash('sha256').update(`${kind}\0${stableStringify(payload)}`).digest('hex');
}

export function readJournal(file: string): JournalEntry[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as JournalEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JournalEntry => e !== null);
}

/**
 * Prefix-order replay. A call matches the first unconsumed recorded entry with
 * an identical fingerprint (fingerprint match rather than strict positional
 * next, so concurrent pipelines resume correctly); a miss runs live. The file
 * is truncated on construction and rewritten in this run's completion order, so
 * every run leaves a clean journal for the next resume.
 */
export class Journal {
  private recorded: (JournalEntry & { consumed?: boolean })[];
  private seq = 0;

  constructor(
    recorded: JournalEntry[],
    private file: string,
  ) {
    this.recorded = recorded.map(e => ({ ...e }));
    fs.writeFileSync(file, '', 'utf8');
  }

  private write(entry: JournalEntry): void {
    entry.seq = this.seq++;
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Recorded result for this fingerprint, or null to run live. */
  replay(fp: string): JournalEntry | null {
    const hit = this.recorded.find(e => !e.consumed && e.fingerprint === fp);
    if (!hit) {
      return null;
    }
    hit.consumed = true;
    const { consumed, ...clean } = hit;
    this.write(clean as JournalEntry);
    return clean as JournalEntry;
  }

  record(entry: Omit<JournalEntry, 'seq'>): void {
    this.write({ ...entry, seq: 0 });
  }
}
