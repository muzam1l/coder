import './segmented.css';
import type { ComponentChildren } from 'preact';
import { Link, type LinkProps } from '@wular/pnext/link';

import type { Option } from './select';

/** One-click choices in a row, a radio group to the keyboard: arrows move and pick, Enter submits the form. */
export function Segmented({
  label,
  options,
  value,
  onChange,
  link,
  class: cls,
  disabled,
  children,
}: {
  label: string;
  options: Array<[value: Option[0], label: ComponentChildren]>;
  value: string;
  /** Without it, `link` makes each choice a page link, or with neither they only show, for a loading page. */
  onChange?: (value: string) => void;
  link?: (value: string) => LinkProps;
  class?: string;
  disabled?: boolean;
  /** More at the row's end, like a menu. */
  children?: ComponentChildren;
}) {
  if (!onChange)
    return (
      <div class={cls ? `seg-btns ${cls}` : 'seg-btns'} role="group" aria-label={label}>
        {options.map(([key, text]) =>
          link ? (
            <Link key={key} {...link(key)} aria-current={key === value ? 'page' : undefined}>
              {text}
            </Link>
          ) : (
            <a key={key}>{text}</a>
          ),
        )}
        {children}
      </div>
    );

  const at = Math.max(
    0,
    options.findIndex(([key]) => key === value),
  );
  return (
    <div
      class={cls ? `seg-btns ${cls}` : 'seg-btns'}
      role="radiogroup"
      aria-label={label}
      onKeyDown={event => {
        const form = (event.currentTarget as HTMLElement).closest('form');
        if (event.key === 'Enter' && form) {
          event.preventDefault();
          return form.requestSubmit();
        }
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = (at + step + options.length) % options.length;
        onChange(options[next]![0]);
        ((event.currentTarget as HTMLElement).children[next] as HTMLElement | undefined)?.focus();
      }}
    >
      {options.map(([key, text], index) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={key === value}
          tabIndex={index === at ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
