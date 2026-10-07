import './field.css';
import type { ComponentChildren } from 'preact';

export function Field({
  label,
  hint,
  group,
  children,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  /** Holds buttons, not one input, so a click on the label picks nothing. */
  group?: boolean;
  children: ComponentChildren;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag class="field">
      <span>
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </Tag>
  );
}

export function ErrorText({ value }: { value?: string }) {
  return value ? (
    <p class="flash err" role="alert">
      {value}
    </p>
  ) : null;
}
