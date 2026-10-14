import './button.css';

import type { ComponentChildren, JSX } from 'preact';
import type { RoutePath } from '@wular/pnext';
import { Link, type LinkProps } from '@wular/pnext/link';

import { iExternal } from './icons';
import { Icon } from './icon';

/** How a button looks; `danger` turns any look red, `class` adds the page's own classes. */
export type Look = {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  danger?: boolean;
  size?: 'sm';
  /** Fills its row. */
  wide?: boolean;
  /** Icon paths for `Icon`. */
  leftIcon?: string;
  rightIcon?: string;
  class?: string;
};

type Attributes = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  'size' | 'loading' | 'class' | 'type' | 'icon' | 'label' | 'ref' | 'disabled'
>;

const classOf = ({ variant, danger, size, wide, class: cls }: Look) =>
  ['btn', variant !== 'primary' && variant, danger && 'danger', size, wide && 'wide', cls]
    .filter(Boolean)
    .join(' ');

/** The label between its icons; a spinner takes the left icon's place, else the right one's, else sits over the label. */
function Content({
  leftIcon,
  rightIcon,
  loading,
  children,
}: Look & { loading?: boolean; children?: ComponentChildren }) {
  const spin = <i class="btn-spin" />;

  return (
    <>
      {leftIcon ? loading ? spin : <Icon d={leftIcon} /> : null}
      {children}
      {rightIcon ? loading && !leftIcon ? spin : <Icon d={rightIcon} /> : null}
    </>
  );
}

/** A button, or a plain link to `href` while it is enabled; `loading` disables it and shows a spinner. */
export function Button({
  variant,
  danger,
  size,
  wide,
  leftIcon,
  rightIcon,
  loading,
  disabled,
  href,
  external,
  as,
  type = 'button',
  class: cls,
  children,
  ...rest
}: Look &
  Attributes & {
    loading?: boolean;
    disabled?: boolean;
    /** A full page load: another site or a server endpoint; in-app pages use `LinkButton`. */
    href?: string;
    /** Opens `href` in a new tab, marked with the external icon. */
    external?: boolean;
    /** Only the look, for a label inside a control that takes the click itself, like a `summary`. */
    as?: 'span';
    type?: 'button' | 'submit';
    children?: ComponentChildren;
  }) {
  const className = classOf({ variant, danger, size, wide, class: cls });
  const content = (
    <Content
      leftIcon={leftIcon}
      rightIcon={rightIcon ?? (external ? iExternal : undefined)}
      loading={loading}
    >
      {children}
    </Content>
  );

  if (as === 'span')
    return (
      <span class={className} aria-hidden="true">
        {content}
      </span>
    );
  if (href && !disabled && !loading)
    return (
      <a
        {...(rest as JSX.AnchorHTMLAttributes<HTMLAnchorElement>)}
        class={className}
        href={href}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {content}
      </a>
    );
  return (
    <button
      aria-busy={loading || undefined}
      {...rest}
      type={type}
      class={className}
      disabled={disabled || loading}
    >
      {content}
    </button>
  );
}

/** A `Button` that links to an in-app page, with `Link`'s typed route and params. */
export function LinkButton<Route extends RoutePath>({
  variant,
  danger,
  size,
  wide,
  leftIcon,
  rightIcon,
  class: cls,
  children,
  ...link
}: Look & LinkProps<Route>) {
  return (
    <Link {...(link as LinkProps)} class={classOf({ variant, danger, size, wide, class: cls })}>
      <Content leftIcon={leftIcon} rightIcon={rightIcon}>
        {children}
      </Content>
    </Link>
  );
}

/** A square button that shows only an icon, named by `label`. */
export function IconButton({
  icon,
  label,
  tip,
  type = 'button',
  class: cls,
  children,
  ...rest
}: Attributes & {
  /** An icon path; `children` draws anything else. */
  icon?: string;
  label: string;
  /** A styled tooltip in place of the native title, where the layout shows one. */
  tip?: string;
  type?: 'button' | 'submit';
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <button
      {...rest}
      type={type}
      class={cls ? `icon-btn ${cls}` : 'icon-btn'}
      aria-label={label}
      title={tip ? undefined : label}
      data-tip={tip}
    >
      {icon ? <Icon d={icon} /> : children}
    </button>
  );
}
