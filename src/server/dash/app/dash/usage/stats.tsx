import './stats.css';
import type { ComponentChildren } from 'preact';

export function Stats({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <section class="stats" aria-label={label}>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div>
      <small>{label}</small>
      {typeof value === 'object' ? value : <strong>{value}</strong>}
    </div>
  );
}
