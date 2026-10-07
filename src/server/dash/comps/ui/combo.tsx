import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Icon } from './icon';
import { iCheck } from './icons';

const SHOWN = 50;

/** A text input with suggestions under it, filtered as you type; any text is still a value. */
export function Combo({
  label,
  name,
  class: className,
  options,
  placeholder,
  value,
  onChange,
  onOpen,
}: {
  label: string;
  name: string;
  class?: string;
  /** Called when the field is focused or clicked, so a caller can fetch its options on demand. */
  onOpen?: () => void;
  options: string[];
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Only text typed since opening filters; opening on a picked value shows every option.
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const query = typed ? value.trim().toLowerCase() : '';
  const shown = (
    query ? options.filter(option => option.toLowerCase().includes(query)) : options
  ).slice(0, SHOWN);
  const listed = open && shown.length > 0;

  const pick = (index: number) => {
    const picked = shown[index];
    if (picked) onChange(picked);
    setOpen(false);
    setTyped(false);
  };

  useLayoutEffect(() => {
    if (!listed) return;
    list.current?.showPopover();
    const position = () => {
      const box = input.current?.getBoundingClientRect();
      const menu = list.current;
      if (!box || !menu) return;
      const below = innerHeight - box.bottom - 12;
      const up = below < Math.min(menu.scrollHeight, 240) && box.top > below;
      setPlace(
        `left:${Math.round(Math.min(box.left, innerWidth - menu.offsetWidth - 8))}px;min-width:${Math.round(box.width)}px;` +
          (up
            ? `bottom:${Math.round(innerHeight - box.top + 4)}px;max-height:${Math.round(Math.min(360, box.top - 12))}px`
            : `top:${Math.round(box.bottom + 4)}px;max-height:${Math.round(Math.min(360, below))}px`),
      );
    };
    position();
    addEventListener('resize', position);
    addEventListener('scroll', position, true);
    return () => {
      removeEventListener('resize', position);
      removeEventListener('scroll', position, true);
    };
  }, [listed, shown.length]);

  useLayoutEffect(() => {
    if (listed)
      list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [listed, active, place]);

  return (
    <>
      <input
        ref={input}
        name={name}
        class={className}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={`${id}-list`}
        aria-activedescendant={listed ? `${id}-${active}` : undefined}
        autocomplete="off"
        placeholder={placeholder}
        value={value}
        onInput={event => {
          onChange(event.currentTarget.value);
          setTyped(true);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
          onOpen?.();
        }}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
        onBlur={() => {
          setOpen(false);
          setTyped(false);
        }}
        onKeyDown={event => {
          if (!listed) return;
          if (event.key === 'ArrowDown') setActive((active + 1) % shown.length);
          else if (event.key === 'ArrowUp') setActive((active - 1 + shown.length) % shown.length);
          else if (event.key === 'Enter') pick(active);
          else if (event.key === 'Escape') setOpen(false);
          else return;
          event.preventDefault();
        }}
      />
      {listed ? (
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
          {shown.map((option, index) => (
            <div
              key={option}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option === value}
              class={index === active ? 'pop-item on' : 'pop-item'}
              onPointerMove={() => index !== active && setActive(index)}
              onClick={() => pick(index)}
            >
              <span class="grow">{option}</span>
              <Icon d={iCheck} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
