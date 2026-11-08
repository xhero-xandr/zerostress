// The owner's key of a task arrives in the fragment (#k=...), so it never reaches a server, a log or a Referer. It is
// then taken out of the address at once and kept by this tab (sessionStorage): an address copied from the bar, or a
// screenshot of it, no longer hands the right to decide to whoever gets it. When the tab cannot keep it (storage off),
// the key stays in the address, as before, rather than the owner losing it.
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { keyFromHash } from './logic.ts';

const slot = (id: string) => `zs-task-key:${id}`;

function kept(id: string): string {
  try {
    return sessionStorage.getItem(slot(id)) ?? '';
  } catch {
    return '';
  }
}

function keep(id: string, key: string): boolean {
  try {
    sessionStorage.setItem(slot(id), key);
    return true;
  } catch {
    return false;
  }
}

/** The key of task `id` for this tab: from the address (which it then leaves) or from what the tab kept. */
export function useTaskKey(id: string): string {
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  const given = id ? keyFromHash(hash) : '';
  const stored = given !== '' && keep(id, given);
  useEffect(() => {
    if (stored) void navigate({ pathname, search, hash: '' }, { replace: true });
  }, [stored, navigate, pathname, search]);
  return given || (id ? kept(id) : '');
}
