import './filter.css';
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { FILTER_ROWS } from '@/utils/paged';
import { iLeft, iRight, iX } from './icons';
import { Chip } from './badge';
import { Icon } from './icon';
import { Menu } from './menu';
import { LoadingMenu, MenuItem, MenuLabel, MenuNote, MenuRadio } from './menu-items';
import type { Option } from './select';
import { Search } from './toolbar';

const RECENT = 'coder:filters';

/** From this many options a facet's full list gets a find box. */
const FIND = 5;

/** One thing a list filters by; an empty value is its default and shows no chip. */
export interface Facet<K extends string = string> {
  key: K;
  label: string;
  /** The picks shown before typing. */
  options: Option[];
  /** A fixed list, always in the menu with its default as a row; its chip is its pick alone. */
  inline?: boolean;
  /** Each pick's icon: an icon path or a ready element. */
  icon?: (value: string) => string | ComponentChildren;
  /** Finds picks on the server once something is typed, at most `limit`. */
  search?: (q: string, limit: number) => Promise<Option[]>;
}

/** How many of a facet's picks the menu lists before "More". */
const SHOWN = 5;

/** The picks the menu lists for a facet: the first few, keeping the current pick in view. */
export function inlineRows(picks: Option[], value: string) {
  if (picks.length <= SHOWN) return picks;
  const shown = picks.slice(0, SHOWN);
  const current = picks.find(([key]) => key === value);

  return current && !shown.includes(current) ? [...shown.slice(0, SHOWN - 1), current] : shown;
}

/** Whether a facet's own list needs a find box. */
const findable = (facet: Facet) => facet.options.filter(([value]) => value).length >= FIND;

/** What a facet's value reads as; "Any" for its default. */
export function valueLabel<K extends string>(
  facet: Facet<K>,
  value: string,
  seen: Record<string, string> = {},
) {
  if (!value) return 'Any';

  return (
    facet.options.find(([key]) => key === value)?.[1] ?? seen[`${facet.key}:${value}`] ?? value
  );
}

/** The filters that are on, one chip each in facet order. */
export function filterChips<K extends string>(
  facets: Facet<K>[],
  values: Record<K, string>,
  seen: Record<string, string> = {},
) {
  return facets
    .filter(facet => values[facet.key])
    .map(facet => {
      const label = valueLabel(facet, values[facet.key], seen);

      return { key: facet.key, text: facet.inline ? label : `${facet.label}: ${label}` };
    });
}

/** A facet list's rows: recent picks that match first, then the rest, at most FILTER_ROWS. */
export function listRows(rows: Option[], recent: Option[], q: string) {
  const needle = q.trim().toLowerCase();
  const first = recent.filter(([, label]) => label.toLowerCase().includes(needle));
  const all = [...first, ...rows.filter(([value]) => !first.some(([kept]) => kept === value))];

  return { shown: all.slice(0, FILTER_ROWS), more: all.length > FILTER_ROWS };
}

function readRecent(): Record<string, Option[]> {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function keepRecent(list: string, pick: Option) {
  const all = readRecent();
  all[list] = [pick, ...(all[list] ?? []).filter(([value]) => value !== pick[0])].slice(0, 5);
  localStorage.setItem(RECENT, JSON.stringify(all));
}

/** One Filter button over every facet, and a removable chip for each filter that is on; `name` keeps each list's recent picks apart. */
export function Filter<K extends string>({
  name,
  facets,
  values,
  onChange,
}: {
  name: string;
  facets: Facet<K>[];
  values: Record<K, string>;
  onChange: (key: K, value: string) => void;
}) {
  // Labels of picks the options lack, so a chip names an agent found by search.
  const [seen, setSeen] = useState<Record<string, string>>({});
  const remember = (key: K, rows: Option[]) =>
    setSeen(current => ({
      ...current,
      ...Object.fromEntries(rows.map(([value, label]) => [`${key}:${value}`, label])),
    }));
  useEffect(() => {
    const recent = readRecent();
    for (const facet of facets) remember(facet.key, recent[`${name}:${facet.key}`] ?? []);
  }, []);
  const chips = filterChips(facets, values, seen);

  return (
    <>
      <Menu
        class="filter-more"
        summaryClass={`field-btn${chips.length ? ' on' : ''}`}
        summary={chips.length ? `Filter · ${chips.length}` : 'Filter'}
      >
        <FilterPanel
          name={name}
          facets={facets}
          values={values}
          seen={seen}
          onFound={remember}
          onPick={(facet, [value, label]) => {
            if (!facet.inline && value !== values[facet.key]) {
              keepRecent(`${name}:${facet.key}`, [value, label]);
              remember(facet.key, [[value, label]]);
            }
            onChange(facet.key, facet.inline || value !== values[facet.key] ? value : '');
          }}
        />
      </Menu>
      <span class="filter-chips">
        {chips.map(chip => (
          <Chip
            key={chip.key}
            title={chip.text}
            aria-label={`Clear ${chip.text}`}
            onClick={() => onChange(chip.key, '')}
          >
            <span class="grow">{chip.text}</span>
            <Icon d={iX} />
          </Chip>
        ))}
      </span>
    </>
  );
}

/** The Filter button while its list loads, inert. */
export const LoadingFilter = () => (
  <LoadingMenu class="filter-more" summaryClass="field-btn" summary="Filter" />
);

/** The menu's facets; a long facet opens its own list in place, and Escape steps back out of it. */
function FilterPanel<K extends string>({
  name,
  facets,
  values,
  seen,
  onFound,
  onPick,
}: {
  name: string;
  facets: Facet<K>[];
  values: Record<K, string>;
  seen: Record<string, string>;
  onFound: (key: K, rows: Option[]) => void;
  onPick: (facet: Facet<K>, pick: Option) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Facet<K>>();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Option[]>();
  const asked = useRef(0);
  const from = useRef<K>();
  const typed = q.trim();

  const focus = (selector: string) => root.current?.querySelector<HTMLElement>(selector)?.focus();
  const show = (facet?: Facet<K>) => {
    if (facet) from.current = facet.key;
    setOpen(facet);
    setQ('');
    setFound(undefined);
  };

  useEffect(() => {
    const pop = root.current!.closest<HTMLElement>('[popover]')!;
    const toggle = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') focus('button');
      else show();
    };
    pop.addEventListener('toggle', toggle);
    return () => pop.removeEventListener('toggle', toggle);
  }, []);

  useEffect(() => {
    if (!root.current?.closest(':popover-open')) return;
    focus(open ? 'input' : `[data-facet="${from.current}"]`);
  }, [open]);

  useEffect(() => {
    if (!open?.search || !typed) return;
    const ask = ++asked.current;
    const timer = setTimeout(
      () =>
        void open.search!(typed, FILTER_ROWS + 1).then(
          rows => {
            if (asked.current !== ask) return;
            setFound(rows);
            onFound(open.key, rows);
          },
          () => asked.current === ask && setFound([]),
        ),
      200,
    );
    return () => clearTimeout(timer);
  }, [open, typed]);

  const rows = open
    ? open.search && typed
      ? (found ?? [])
      : open.options.filter(
          ([value, label]) => value && label.toLowerCase().includes(typed.toLowerCase()),
        )
    : [];
  const list = open
    ? listRows(rows, readRecent()[`${name}:${open.key}`] ?? [], typed)
    : { shown: [], more: false };
  const searching = Boolean(open?.search && typed && !found);

  const onKeyDown = (event: KeyboardEvent) => {
    const items = [...root.current!.querySelectorAll<HTMLElement>('input, button')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = event.target as HTMLElement;
    const key = event.key;
    if (key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
    else if (key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
    else if (key === 'ArrowRight' && target.dataset.facet) target.click();
    else if (key === 'ArrowLeft' && open && target.tagName !== 'INPUT') show();
    else if (key === 'Enter' && target.tagName === 'INPUT') focus('[role=menuitemradio]');
    else if (key === 'Escape' && open) {
      event.stopPropagation();
      show();
    } else return;
    event.preventDefault();
  };

  return (
    <div ref={root} class="filter-panel" onKeyDown={onKeyDown}>
      {open ? (
        <>
          <MenuItem data-keep icon={iLeft} title={open.label} onClick={() => show()} />
          {findable(open) ? (
            <Search
              value={q}
              label={`Find ${open.label.toLowerCase()}`}
              autocomplete="off"
              onInput={setQ}
            />
          ) : null}
          <div role="group" aria-label={open.label} aria-busy={searching}>
            {list.shown.map(([value, label]) => (
              <MenuRadio
                key={value}
                icon={open.icon?.(value)}
                on={values[open.key] === value}
                onPick={() => onPick(open, [value, label])}
              >
                {label}
              </MenuRadio>
            ))}
          </div>
          {list.more ? (
            <MenuNote>Type to find more.</MenuNote>
          ) : !list.shown.length && !searching ? (
            <MenuNote>Nothing matches.</MenuNote>
          ) : null}
        </>
      ) : (
        facets.map(facet => {
          const picks = facet.options.filter(([value]) => facet.inline || value);
          if (!picks.length) return null;
          const shown = inlineRows(picks, values[facet.key]);

          return (
            <Fragment key={facet.key}>
              <MenuLabel>{facet.label}</MenuLabel>
              <div role="group" aria-label={facet.label}>
                {shown.map(([value, label]) => (
                  <MenuRadio
                    key={value}
                    icon={facet.icon?.(value)}
                    on={values[facet.key] === value}
                    onPick={() => onPick(facet, [value, label])}
                  >
                    {label}
                  </MenuRadio>
                ))}
              </div>
              {picks.length > shown.length ? (
                <MenuItem
                  data-keep
                  data-facet={facet.key}
                  aria-haspopup="true"
                  title="More"
                  end={
                    <>
                      <span class="muted">{picks.length - shown.length}</span>
                      <Icon d={iRight} />
                    </>
                  }
                  onClick={() => show(facet)}
                />
              ) : null}
            </Fragment>
          );
        })
      )}
    </div>
  );
}
