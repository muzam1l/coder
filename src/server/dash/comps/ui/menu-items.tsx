import './menu.css';

import type { ComponentChildren, JSX, Ref } from 'preact';
import type { RoutePath } from '@wular/pnext';
import { Link, type LinkProps } from '@wular/pnext/link';

import { iCheck } from './icons';
import { Icon } from './icon';

/** What a row shows around its label. */
type Parts = {
  /** An icon path or a ready element, like an avatar. */
  icon?: string | ComponentChildren;
  /** A second, muted line under the label. */
  sub?: ComponentChildren;
  /** After the label, like a count, a hint or an icon. */
  end?: ComponentChildren;
};

const classOf = (...names: Array<string | false | undefined>) =>
  ['pop-item', ...names].filter(Boolean).join(' ');

function Content({ icon, sub, end, children }: Parts & { children: ComponentChildren }) {
  return (
    <>
      {typeof icon === 'string' ? <Icon d={icon} /> : icon}
      <span class="grow">
        {children}
        {sub ? <small>{sub}</small> : null}
      </span>
      {end}
    </>
  );
}

/** A menu row that acts; with `sub` it aligns to its top. */
export function MenuItem({
  icon,
  title,
  sub,
  end,
  href,
  type = 'button',
  disabled,
  danger,
  ...rest
}: Parts &
  Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'icon' | 'type' | 'disabled'> & {
    title: ComponentChildren;
    /** A full page load: another site or a server endpoint; in-app pages use `MenuLink`. */
    href?: string;
    type?: 'button' | 'submit';
    /** Shown, never picked. */
    disabled?: boolean;
    /** Destructive: red on hover. */
    danger?: boolean;
  }) {
  const cls = classOf(sub ? 'rich' : false, danger && 'danger');
  const content = (
    <Content icon={icon} sub={sub} end={end}>
      {title}
    </Content>
  );

  if (disabled)
    return (
      <div class={cls} aria-disabled="true">
        {content}
      </div>
    );
  if (href)
    return (
      <a {...(rest as JSX.AnchorHTMLAttributes<HTMLAnchorElement>)} class={cls} href={href}>
        {content}
      </a>
    );
  return (
    <button {...rest} type={type} class={cls}>
      {content}
    </button>
  );
}

/** A `MenuItem` that links to an in-app page, with `Link`'s typed route and params. */
export function MenuLink<Route extends RoutePath>({
  icon,
  sub,
  end,
  class: cls,
  children,
  ...link
}: Parts & LinkProps<Route>) {
  return (
    <Link {...(link as LinkProps)} class={classOf(sub ? 'rich' : false, cls as string)}>
      <Content icon={icon} sub={sub} end={end}>
        {children}
      </Content>
    </Link>
  );
}

/** One choice in a menu section; the picked one shows its check. */
export function MenuRadio({
  on,
  onPick,
  href,
  disabled,
  icon,
  sub,
  end,
  children,
}: Parts & {
  on: boolean;
  onPick?: () => void;
  /** A full page load picks it. */
  href?: string;
  /** Shown, never picked, like the page already open. */
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const props = {
    role: 'menuitemradio' as const,
    'aria-checked': on,
    class: classOf(on && 'on', sub ? 'rich' : false),
  };
  const content = (
    <Content
      icon={icon}
      sub={sub}
      end={
        <>
          {end}
          <Icon d={iCheck} />
        </>
      }
    >
      {children}
    </Content>
  );

  if (disabled)
    return (
      <div {...props} aria-disabled="true">
        {content}
      </div>
    );
  if (href)
    return (
      <a href={href} {...props}>
        {content}
      </a>
    );
  return (
    <button type="button" {...props} onClick={onPick}>
      {content}
    </button>
  );
}

/** One option of a listbox; `active` follows the pointer and arrows, `check` marks the selected one. */
export function MenuOption({
  active,
  selected,
  check,
  icon,
  sub,
  end,
  class: cls,
  children,
  ...rest
}: Parts &
  Omit<JSX.HTMLAttributes<HTMLDivElement>, 'icon' | 'class' | 'selected'> & {
    active: boolean;
    selected: boolean;
    check?: boolean;
    class?: string;
    children: ComponentChildren;
  }) {
  return (
    <div {...rest} role="option" aria-selected={selected} class={classOf(active && 'on', cls)}>
      <Content
        icon={icon}
        sub={sub}
        end={
          <>
            {end}
            {check ? <Icon d={iCheck} /> : null}
          </>
        }
      >
        {children}
      </Content>
    </div>
  );
}

/** A section title in a menu. */
export const MenuLabel = ({
  children,
  ...rest
}: Omit<JSX.HTMLAttributes<HTMLParagraphElement>, 'class'>) => (
  <p {...rest} class="pop-label">
    {children}
  </p>
);

/** A muted line in a menu, like an empty list's explanation. */
export const MenuNote = ({ children }: { children: ComponentChildren }) => (
  <p class="pop-note">{children}</p>
);

/** Who or what the menu is about, above its sections. */
export const MenuHead = ({
  icon,
  title,
  sub,
}: {
  icon: ComponentChildren;
  title: ComponentChildren;
  sub: ComponentChildren;
}) => (
  <div class="pop-head">
    {icon}
    <div class="grow">
      <b>{title}</b>
      <small>{sub}</small>
    </div>
  </div>
);

/** An item with a control beside it, like a chevron that opens more under it. */
export const MenuRow = ({ children }: { children: ComponentChildren }) => (
  <div class="pop-row">{children}</div>
);

/** A menu's button before its page arrives, inert; a client `Menu` there would hydrate for nothing. */
export const LoadingMenu = ({
  summary,
  summaryClass,
  class: cls,
}: {
  summary: ComponentChildren;
  summaryClass?: string;
  class?: string;
}) => (
  <span class={cls ? `menu ${cls}` : 'menu'}>
    <button type="button" class={summaryClass} disabled tabIndex={-1}>
      {summary}
    </button>
  </span>
);

/** A menu's panel that its own code opens, like a select's list; `panelRef` reaches the element. */
export function MenuPanel({
  panelRef,
  class: cls,
  children,
  ...rest
}: Omit<JSX.HTMLAttributes<HTMLDivElement>, 'class'> & {
  panelRef?: Ref<HTMLDivElement>;
  class?: string;
}) {
  return (
    <div {...rest} ref={panelRef} class={cls ? `pop ${cls}` : 'pop'}>
      {children}
    </div>
  );
}
