import './select.css';
import type { ComponentChildren, Ref, RefObject } from 'preact';
import { Fragment } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { iDown, iPlus } from './icons';
import { Icon } from './icon';
import { MenuLabel, MenuOption, MenuPanel } from './menu-items';

export type Option = [value: string, label: string];

const PAGE = 10;

/** A top-layer list's place at `anchor`, flipped up near the bottom, following scrolls and resizes; a dialog or scroll box never clips it. */
export function usePlace(
  anchor: RefObject<HTMLElement>,
  list: RefObject<HTMLElement>,
  open: boolean,
  max: number,
  deps: unknown[] = [],
) {
  const [place, setPlace] = useState('');

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.showPopover();
    const position = () => {
      const box = anchor.current?.getBoundingClientRect();
      const menu = list.current;
      if (!box || !menu) return;
      const below = innerHeight - box.bottom - 12;
      const up = below < Math.min(menu.scrollHeight, 240) && box.top > below;
      setPlace(
        `left:${Math.round(Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px;min-width:${Math.round(box.width)}px;` +
          (up
            ? `bottom:${Math.round(innerHeight - box.top + 4)}px;max-height:${Math.round(Math.min(max, box.top - 12))}px`
            : `top:${Math.round(box.bottom + 4)}px;max-height:${Math.round(Math.min(max, below))}px`),
      );
    };
    position();
    addEventListener('resize', position);
    addEventListener('scroll', position, true);
    return () => {
      removeEventListener('resize', position);
      removeEventListener('scroll', position, true);
    };
  }, [open, ...deps]);

  return place;
}

/** A select in the menu style, with keyboard, type-ahead and touch; `name` posts its value. */
export function Select({
  label,
  options,
  value,
  defaultValue,
  onChange,
  onFocus,
  name,
  disabled,
  headings,
  subs,
  unavailable,
  icons,
  action,
}: {
  label: string;
  options: Option[];
  /** Section titles shown above the options with these values. */
  headings?: Record<string, string>;
  /** A second, muted line under an option, clipped from the start, for paths. */
  subs?: Record<string, string>;
  /** Options shown but never picked, with why under their label. */
  unavailable?: Record<string, string>;
  /** A mark before an option's label, like a platform's logo; the button shows the picked one's. */
  icons?: Record<string, ComponentChildren>;
  /** One last row that acts instead of selecting, like "Add models"; it joins hover and keyboard like an option. */
  action?: { label: string; icon?: string; onPick: () => void };
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Also on press, since Safari gives a clicked button no focus. */
  onFocus?: () => void;
  name?: string;
  disabled?: boolean;
}) {
  const [own, setOwn] = useState(defaultValue ?? options[0]?.[0] ?? '');
  // A value the options no longer hold falls back to the first, as a native select does.
  const selected = Math.max(
    0,
    options.findIndex(([key]) => key === (value ?? own)),
  );
  const current = options[selected]?.[0] ?? '';
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const place = usePlace(button, list, open, 560);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();

  const show = (index = selected) => {
    setActive(index);
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const pick = (index: number) => {
    if (action && index === options.length) {
      close();
      action.onPick();
      return;
    }
    const next = options[index]?.[0];
    if (next !== undefined && unavailable?.[next]) return;
    close();
    if (next === undefined || next === current) return;
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  /** Type-ahead: the next label starting with what was typed; one key repeated cycles. */
  const seek = (key: string, from: number) => {
    const now = Date.now();
    const text = now - typed.current.at > 600 ? key : typed.current.text + key;
    typed.current = { text, at: now };
    const needle = /^(.)\1*$/.test(text) ? text[0]! : text;
    const start = needle.length === 1 ? from + 1 : from;
    for (let step = 0; step < options.length; step++) {
      const index = (start + step) % options.length;
      if (options[index]![1].toLowerCase().startsWith(needle.toLowerCase())) return index;
    }
    return -1;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const last = options.length - 1 + (action ? 1 : 0);
    const key = event.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) show();
      else if (key === 'Home') show(0);
      else if (key === 'End') show(last);
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
        const found = seek(key, selected);
        if (found >= 0) show(found);
        else return;
      } else return;
      event.preventDefault();
      return;
    }
    if (key === 'ArrowDown') setActive(Math.min(last, active + 1));
    else if (key === 'ArrowUp' && event.altKey) pick(active);
    else if (key === 'ArrowUp') setActive(Math.max(0, active - 1));
    else if (key === 'Home') setActive(0);
    else if (key === 'End') setActive(last);
    else if (key === 'PageDown') setActive(Math.min(last, active + PAGE));
    else if (key === 'PageUp') setActive(Math.max(0, active - PAGE));
    else if (key === 'Enter' || (key === ' ' && Date.now() - typed.current.at > 600)) pick(active);
    else if (key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (key === 'Tab') {
      if (unavailable?.[options[active]?.[0] ?? '']) close(false);
      else pick(active);
      return;
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const found = seek(key, active);
      if (found >= 0) setActive(found);
    } else return;
    event.preventDefault();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !list.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useLayoutEffect(() => {
    if (open)
      list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, place]);

  return (
    <span class="select">
      <button
        ref={button}
        type="button"
        role="combobox"
        data-keep
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        onFocus={onFocus}
        onPointerDown={onFocus}
        onClick={event => {
          event.preventDefault();
          if (open) close();
          else show();
        }}
        onKeyDown={onKeyDown}
      >
        {icons?.[current] ?? null}
        <span class="grow">{options[selected]?.[1] ?? ''}</span>
        <Icon d={iDown} />
      </button>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      {open ? (
        <SelectList id={id} label={label} listRef={list} place={place}>
          {options.map(([key, text], index) => (
            <Fragment key={key}>
              {headings?.[key] ? <MenuLabel>{headings[key]}</MenuLabel> : null}
              <MenuOption
                id={`${id}-${index}`}
                data-index={index}
                active={index === active}
                selected={index === selected}
                check
                icon={icons?.[key]}
                aria-disabled={unavailable?.[key] ? 'true' : undefined}
                sub={unavailable?.[key] ?? (subs?.[key] ? <bdi dir="ltr">{subs[key]}</bdi> : null)}
                onPointerMove={() => index !== active && setActive(index)}
                // Picks without letting a wrapping label re-open the list.
                onClick={event => {
                  event.preventDefault();
                  pick(index);
                }}
              >
                {text}
              </MenuOption>
            </Fragment>
          ))}
          {action ? (
            <MenuOption
              id={`${id}-${options.length}`}
              data-index={options.length}
              active={active === options.length}
              selected={false}
              class="action"
              icon={action.icon ?? iPlus}
              onPointerMove={() => active !== options.length && setActive(options.length)}
              onClick={event => {
                event.preventDefault();
                pick(options.length);
              }}
            >
              {action.label}
            </MenuOption>
          ) : null}
        </SelectList>
      ) : null}
    </span>
  );
}

/** A select's list in the top layer at `place`; the field keeps focus, so the mouse never takes it. */
export const SelectList = ({
  id,
  label,
  listRef,
  place,
  children,
}: {
  id: string;
  label: string;
  listRef: Ref<HTMLDivElement>;
  place: string;
  children: ComponentChildren;
}) => (
  <MenuPanel
    panelRef={listRef}
    id={`${id}-list`}
    class="select-pop"
    popover="manual"
    role="listbox"
    aria-label={label}
    style={place || 'visibility:hidden'}
    onMouseDown={event => event.preventDefault()}
  >
    {children}
  </MenuPanel>
);
