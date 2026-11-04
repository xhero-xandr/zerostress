// The detection rules (spec 009, 3.4 and 3.9). They are data, in hooks/rules/*.json; ruleset.ts reads and checks them.
// The set is loaded when this module is first imported. If it is not exactly right, the import throws and the hooks do
// not start: a damaged rule set must never mean "no rules".

import { fileURLToPath } from 'node:url';
import type { Rule, SquashedSet } from './kinds.ts';
import { loadRuleset } from './ruleset.ts';

export { CATEGORIES, SUPPORT, weakActivates } from './kinds.ts';
export type { Category, Rule, SquashedSet, Strength } from './kinds.ts';

const loaded = loadRuleset(fileURLToPath(new URL('./rules/', import.meta.url)));

export const RULES: readonly Rule[] = loaded.rules;
export const SQUASHED: readonly SquashedSet[] = loaded.squashed;
/** SHA-256 of the rule files: recorded with every run */
export const RULESET_SHA256: string = loaded.hash;
