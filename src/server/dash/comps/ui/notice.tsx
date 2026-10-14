import type { ComponentChildren } from 'preact';

/** An alert bar, neutral unless given a tone; `slim` keeps it to one line. */
export function Notice({
  tone,
  slim,
  children,
}: {
  tone?: 'warning' | 'error';
  slim?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class={['notice', slim && 'slim', tone].filter(Boolean).join(' ')} role="status">
      {children}
    </div>
  );
}
