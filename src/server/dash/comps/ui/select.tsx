import './select.css';
import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { iCheck, iDown, iPlus } from './icons';
import { Icon } from './icon';

export type Option = [value: string, label: string];

const PAGE = 10;

/** A select in the menu style, with keyboard, type-ahead and touch; `name` posts its value. */
export function Select({
  label,
  options,
  value,
  defaultValue,
  onChange,
  name,
  disabled,
  headings,
  subs,
  action,
}: {
  label: string;
  options: Option[];
  /** Section titles shown above the options with these values. */
  headings?: Record<string, string>;
  /** A second, muted line under an option, clipped from the start, for paths. */
  subs?: Record<string, string>;
  /** One last row that acts instead of selecting, like "Add models"; it joins hover and keyboard like an option. */
  action?: { label: string; icon?: string; onPick: () => void };
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
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
  const [place, setPlace] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
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
      pick(active);
      return;
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const found = seek(key, active);
      if (found >= 0) setActive(found);
    } else return;
    event.preventDefault();
  };

  // In the top layer, so a dialog or scroll box never clips it; flips up near the bottom.
  useLayoutEffect(() => {
    if (!open) return;
    list.current?.showPopover();
    const position = () => {
      const box = button.current?.getBoundingClientRect();
      const menu = list.current;
      if (!box || !menu) return;
      const below = innerHeight - box.bottom - 12;
      const up = below < Math.min(menu.scrollHeight, 240) && box.top > below;
      setPlace(
        `left:${Math.round(Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px;min-width:${Math.round(box.width)}px;` +
          (up
            ? `bottom:${Math.round(innerHeight - box.top + 4)}px;max-height:${Math.round(Math.min(480, box.top - 12))}px`
            : `top:${Math.round(box.bottom + 4)}px;max-height:${Math.round(Math.min(480, below))}px`),
      );
    };
    position();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !list.current?.contains(target)) close(false);
    };
    addEventListener('resize', position);
    addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      removeEventListener('resize', position);
      removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', outside);
    };
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
        onClick={event => {
          event.preventDefault();
          if (open) close();
          else show();
        }}
        onKeyDown={onKeyDown}
      >
        <span class="grow">{options[selected]?.[1] ?? ''}</span>
        <Icon d={iDown} />
      </button>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      {open ? (
        <div
          ref={list}
          id={`${id}-list`}
          class="pop select-pop"
          popover="manual"
          role="listbox"
          aria-label={label}
          style={place || 'visibility:hidden'}
          onMouseDown={event => event.preventDefault()}
        >
          {options.map(([key, text], index) => (
            <Fragment key={key}>
              {headings?.[key] ? <p class="pop-label">{headings[key]}</p> : null}
              <div
                id={`${id}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                class={index === active ? 'pop-item on' : 'pop-item'}
                onPointerMove={() => index !== active && setActive(index)}
                // Picks without letting a wrapping label re-open the list.
                onClick={event => {
                  event.preventDefault();
                  pick(index);
                }}
              >
                <span class="grow">
                  {text}
                  {subs?.[key] ? (
                    <small class="pop-path">
                      <bdi dir="ltr">{subs[key]}</bdi>
                    </small>
                  ) : null}
                </span>
                <Icon d={iCheck} />
              </div>
            </Fragment>
          ))}
          {action ? (
            <div
              id={`${id}-${options.length}`}
              data-index={options.length}
              role="option"
              aria-selected={false}
              class={active === options.length ? 'pop-item action on' : 'pop-item action'}
              onPointerMove={() => active !== options.length && setActive(options.length)}
              onClick={event => {
                event.preventDefault();
                pick(options.length);
              }}
            >
              <Icon d={action.icon ?? iPlus} />
              <span class="grow">{action.label}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/** The label a filter's value shows. */
export const labelOf = (options: Array<[string, string]>, value: string) =>
  (options.find(([key]) => key === value) ?? options[0]!)[1];
