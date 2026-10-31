import './field.css';
import type { ComponentChildren, JSX, Ref } from 'preact';

export function Field({
  label,
  hint,
  required,
  group,
  children,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren;
  /** Marks the label with a red star. */
  required?: boolean;
  /** Holds buttons, not one input, so a click on the label picks nothing. */
  group?: boolean;
  children: ComponentChildren;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag class="field">
      <span>
        {required ? (
          <span>
            {label}
            <i class="field-req" aria-hidden="true">
              *
            </i>
          </span>
        ) : (
          label
        )}
      </span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </Tag>
  );
}

/** A key or token: text masked by CSS, never a password field, so browsers neither fill, suggest nor save sign-ins for it. */
export function SecretInput({
  inputRef,
  ...props
}: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type' | 'ref'> & {
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      {...props}
      ref={inputRef}
      type="text"
      class="secret"
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
    />
  );
}
