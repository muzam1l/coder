import './toolbar.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { iSearch } from './icons';
import { readQuery, writeQuery } from '@/utils/paged';
import { Icon } from './icon';
import { Sentinel } from './sentinel';

/** The query string for a set of filters, empty ones left out. */
export const queryOf = (values: Record<string, string>) =>
  new URLSearchParams(Object.entries(values).filter(([, value]) => value)).toString();

/** Filter values that live in the address bar; typing settles for a moment before it applies. */
export function useFilters<K extends string>(initial: Record<K, string>) {
  const [values, setValues] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const fromUrl = readQuery(Object.keys(initial)) as Record<K, string>;
    if (Object.keys(initial).some(key => fromUrl[key as K] !== initial[key as K])) {
      setValues(fromUrl);
      setApplied(fromUrl);
    }
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = (key: K, value: string, settle = 0) => {
    const next = { ...values, [key]: value };
    setValues(next);
    clearTimeout(timer.current);
    const apply = () => {
      setApplied(next);
      writeQuery(next);
    };
    if (settle) timer.current = setTimeout(apply, settle);
    else apply();
  };

  return { values, set, query: queryOf(applied) };
}

export function Search({
  value,
  label,
  onInput,
}: {
  value: string;
  label: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class="search">
      <Icon d={iSearch} />
      <input
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        onInput={event => onInput((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  );
}

/** A list's search and filters with its primary action: one row in the page head, or its own row inside a tab. */
export function Toolbar({
  head,
  action,
  children,
}: {
  head?: { title: string; lead?: string };
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return head ? (
    <>
      <Sentinel />
      <header class="head tools">
        <div>
          <h1>{head.title}</h1>
          {head.lead ? <p class="lead">{head.lead}</p> : null}
        </div>
        <div class="filters">{children}</div>
        {action ? <div class="actions">{action}</div> : null}
      </header>
    </>
  ) : (
    <div class="filters">
      {children}
      {action ? <span class="end">{action}</span> : null}
    </div>
  );
}
