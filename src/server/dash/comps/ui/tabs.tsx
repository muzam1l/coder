import './tabs.css';
import { CurrentLink } from '@/comps/nav/current-link';
import type { To } from '@/comps/nav/to';

type TabItem = To & { label: string; count?: number };

const compact = new Intl.NumberFormat('en', { notation: 'compact' });

/** Tabs that are pages under one header; the current one follows the address. */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav class="tabs" aria-label={label}>
      {items.map(({ label, count, ...to }) => (
        <CurrentLink key={label} {...to} prefetch="intent">
          {label}
          {count !== undefined ? <span class="count">{compact.format(count)}</span> : null}
        </CurrentLink>
      ))}
    </nav>
  );
}

/** Tabs before their page arrives: the same row, kept blank until the labels come with their counts. */
export function LoadingTabs({ labels }: { labels: string[] }) {
  return (
    <nav class="tabs" aria-hidden="true">
      {labels.map(label => (
        <a key={label}>{label}</a>
      ))}
    </nav>
  );
}
