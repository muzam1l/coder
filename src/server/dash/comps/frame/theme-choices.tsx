'use client';

import { useState } from 'preact/hooks';

import { iMonitor, iMoon, iSun } from '@/comps/ui/icons';
import { MenuRadio } from '@/comps/ui/menu-items';

const YEAR = 60 * 60 * 24 * 365;

const THEMES = [
  ['light', 'Light', iSun],
  ['dark', 'Dark', iMoon],
  ['system', 'System', iMonitor],
] as const;

/** The theme menu's choices; a pick applies at once and is kept in a cookie. */
export function ThemeChoices({ theme: initial }: { theme: string }) {
  const [theme, setTheme] = useState(initial);
  const pick = (value: string) => {
    const root = document.documentElement;
    if (value === 'system') delete root.dataset.theme;
    else root.dataset.theme = value;

    document.cookie = `theme=${value}; path=/; max-age=${YEAR}; samesite=lax`;
    setTheme(value);
  };

  return (
    <>
      {THEMES.map(([value, label, icon]) => (
        <MenuRadio key={value} on={theme === value} onPick={() => pick(value)} icon={icon}>
          {label}
        </MenuRadio>
      ))}
    </>
  );
}
