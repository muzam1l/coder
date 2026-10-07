import './icon.css';
export function Icon({ d, class: cls }: { d: string; class?: string }) {
  return (
    <svg class={cls ? `ic ${cls}` : 'ic'} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The Coder mark: eight dots on a 16px grid, drawn in currentColor. */
export function Mark() {
  return (
    <svg class="coder-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 0h3v3h-3zM9 0h3v3h-3zM13 0h3v3h-3zM0 4h3v3h-3zM0 9h3v3h-3zM5 13h3v3h-3zM9 13h3v3h-3zM13 13h3v3h-3z" />
    </svg>
  );
}
