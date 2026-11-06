// Light, dark, or whatever the system asks for (the default). The choice is a per-browser convenience in localStorage;
// "system" leaves no attribute, so the CSS media query decides and the page never flashes the wrong theme.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'zs-theme';
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current: Theme = typeof window === 'undefined' ? 'system' : stored();

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

export function setTheme(t: Theme): void {
  current = t;
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch { /* storage may be off: the choice then lasts for this page only */ }
  applyTheme(t);
  for (const l of listeners) l();
}

export const initTheme = (): void => applyTheme(current);

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
    () => 'system',
  );
}
