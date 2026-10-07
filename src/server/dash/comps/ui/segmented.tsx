import './segmented.css';
import type { Option } from './select';

/** One-click choices in a row, a radio group to the keyboard: arrows move and pick, Enter submits the form. */
export function Segmented({
  label,
  options,
  value,
  onChange,
  class: cls,
  disabled,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  class?: string;
  disabled?: boolean;
}) {
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
