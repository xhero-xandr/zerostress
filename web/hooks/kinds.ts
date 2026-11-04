// Kinds of rules and how weak ones add up (spec 009, 3.4). The rules themselves are data: hooks/rules/*.json.

import type { ViewName } from './normalize.ts';

export const CATEGORIES = [
  'override', 'verdict', 'reveal', 'exfil', 'conceal', 'markup', 'smuggle',
  'address', 'directive', 'persona', 'sandbox',
  'authority', 'urgency', 'reward', 'trust',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Strength = 'strong' | 'weak';

/**
 * Pressure used on people as much as on models (authority, urgency, reward, trust). A phishing page for humans is full
 * of it, so these count only together with a message addressed to an AI.
 */
export const SUPPORT: ReadonlySet<Category> = new Set<Category>(['authority', 'urgency', 'reward', 'trust']);

/** Weak kinds activate on two different core kinds, or on an address to an AI plus any pressure kind. */
export function weakActivates(kinds: ReadonlySet<Category>): boolean {
  let core = 0;
  let support = false;
  for (const k of kinds) {
    if (SUPPORT.has(k)) support = true;
    else core++;
  }
  return core >= 2 || (kinds.has('address') && support);
}

export interface Rule {
  id: string;
  category: Category;
  strength: Strength;
  views: ViewName[];
  re: RegExp;
}

/** Phrases for the squashed views (letters and digits only). */
export interface SquashedSet {
  id: string;
  view: 'squashed_lat' | 'squashed_cyr';
  phrases: string[];
}
