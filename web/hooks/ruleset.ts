// The rule set as data (spec 009, 3.9). The rules live in hooks/rules/*.json; this file reads them, checks everything
// and compiles them. Any problem throws, and a hooks module that cannot load its rules does not start: a missing or
// damaged rule set must never mean "no rules".

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, type Rule, type SquashedSet, type Strength } from './kinds.ts';
import { foldPattern, viewOf, type ViewName } from './normalize.ts';

export class RulesetError extends Error {}

export interface Ruleset {
  rules: Rule[];
  squashed: SquashedSet[];
  /** SHA-256 over the names and bytes of all files: recorded with every run, so a result says which rules produced it */
  hash: string;
  files: string[];
}

export const LIMITS = {
  files: 64,
  fileBytes: 512 * 1024,
  rules: 600,
  patternChars: 20_000,
  macros: 200,
  macroChars: 4_000,
  macroDepth: 6,
  examples: 20,
  exampleChars: 500,
  squashedPhrases: 5_000,
  squashedMin: 16,
};

const VIEWS: readonly ViewName[] = ['lat', 'leet', 'cyr', 'raw', 'squashed_lat', 'squashed_cyr', 'rot13', 'reversed'];
const MATCH_VIEWS: readonly ViewName[] = ['lat', 'leet', 'cyr', 'raw', 'rot13', 'reversed'];
const NB = String.raw`[^\p{L}\p{N}]`;
const WD = String.raw`[\p{L}\p{N}']`;
const gap = (n: number) => String.raw`(?:${NB}+${WD}+){0,${n}}${NB}+`;
const boundary = (s: string) => String.raw`(?<![\p{L}\p{N}])(?:${s})(?![\p{L}\p{N}])`;

const fail = (where: string, msg: string): never => {
  throw new RulesetError(`${where}: ${msg}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only the listed keys, all required ones present. */
function keys(where: string, o: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(where, `unknown field "${k}"`);
  for (const k of required) if (!(k in o)) fail(where, `missing field "${k}"`);
}

function stringList(where: string, v: unknown, min: number, max: number, maxChars: number): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail(where, `must be a list of ${min} to ${max} strings`);
  for (const s of v as unknown[]) if (typeof s !== 'string' || s.length > maxChars) fail(where, `every entry must be a string of at most ${maxChars} characters`);
  return v as string[];
}

// ---- macros ---------------------------------------------------------------------------------------------------------

type Macros = Map<string, string>;

function readMacros(where: string, doc: unknown): Macros {
  if (!isObject(doc)) return fail(where, 'must be an object');
  keys(where, doc, ['schema', 'macros']);
  if (doc.schema !== 1) fail(where, 'schema must be 1');
  if (!isObject(doc.macros)) return fail(where, '"macros" must be an object');
  const out: Macros = new Map();
  const entries = Object.entries(doc.macros);
  if (entries.length > LIMITS.macros) fail(where, 'too many macros');
  for (const [name, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(name)) fail(where, `bad macro name "${name}"`);
    if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.macroChars) fail(where, `macro ${name} must be a non-empty string of at most ${LIMITS.macroChars} characters`);
    out.set(name, value as string);
  }
  return out;
}

function expand(where: string, text: string, macros: Macros, depth = 0): string {
  if (depth > LIMITS.macroDepth) return fail(where, 'macros nest too deep (a cycle?)');
  return text.replace(/@([A-Z][A-Z0-9_]*)/g, (_m, name: string) => {
    const v = macros.get(name);
    if (v === undefined) return fail(where, `unknown macro @${name}`);
    return expand(where, v, macros, depth + 1);
  });
}

// ---- patterns -------------------------------------------------------------------------------------------------------

/**
 * Parts: "b:<alternatives>" (a whole word or phrase, bounded by non-letters), "gap:<n>" (up to n words in between),
 * "raw:<regular expression>". @NAME inside a part is a macro.
 */
function buildPattern(where: string, parts: unknown, macros: Macros): string {
  const list = stringList(where, parts, 1, 60, LIMITS.macroChars);
  let out = '';
  for (const part of list) {
    const at = part.indexOf(':');
    const kind = at < 0 ? '' : part.slice(0, at);
    const arg = at < 0 ? '' : part.slice(at + 1);
    if (kind === 'gap') {
      if (!/^[0-9]$/.test(arg)) fail(where, `gap needs a number from 0 to 9, got "${arg}"`);
      out += gap(Number(arg));
    } else if (kind === 'b') {
      if (arg === '') fail(where, 'empty b: part');
      out += boundary(expand(where, arg, macros));
    } else if (kind === 'raw') {
      if (arg === '') fail(where, 'empty raw: part');
      out += expand(where, arg, macros);
    } else {
      fail(where, `a part must start with b:, gap: or raw:, got "${part.slice(0, 20)}"`);
    }
  }
  return out;
}

/** A group with an unbounded repeat inside, itself repeated without bound: the shape behind catastrophic backtracking. */
const NESTED_REPEAT = /\((?:[^()\\]|\\.|\[[^\]]*\])*[+*](?:[^()\\]|\\.|\[[^\]]*\])*\)[+*]/;

function compile(where: string, source: string): RegExp {
  if (source.length > LIMITS.patternChars) fail(where, 'pattern is too long');
  let re: RegExp;
  try {
    re = new RegExp(source, 'gu');
  } catch (e) {
    return fail(where, `the pattern does not compile: ${(e as Error).message}`);
  }
  if (new RegExp(source, 'u').test('')) fail(where, 'the pattern matches the empty string');
  // the bounded gap is written (?:NB+WD+){0,n}: a bounded repeat is allowed, an unbounded one around an unbounded one is not
  if (NESTED_REPEAT.test(source)) fail(where, 'a group with an unbounded repeat is itself repeated without bound');
  return re;
}

function matchesOn(re: RegExp, views: ViewName[], text: string): boolean {
  for (const name of views) {
    const v = viewOf(text, name);
    re.lastIndex = 0;
    if (re.test(v.text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  re.lastIndex = 0;
  return false;
}

// ---- files ----------------------------------------------------------------------------------------------------------

function readRule(where: string, r: unknown, macros: Macros, seen: Set<string>): Rule {
  if (!isObject(r)) return fail(where, 'a rule must be an object');
  keys(where, r, ['id', 'category', 'strength', 'views', 'pattern', 'examples'], ['fold', 'note']);
  const id = r.id;
  if (typeof id !== 'string' || !/^[a-z0-9_.]{2,60}$/.test(id)) return fail(where, `bad rule id ${JSON.stringify(id)}`);
  const here = `${where} ${id}`;
  if (seen.has(id)) fail(here, 'duplicate rule id');
  seen.add(id);
  if (typeof r.category !== 'string' || !(CATEGORIES as readonly string[]).includes(r.category)) fail(here, `unknown category ${JSON.stringify(r.category)}`);
  if (r.strength !== 'strong' && r.strength !== 'weak') fail(here, 'strength must be "strong" or "weak"');
  const views = stringList(here, r.views, 1, 6, 20) as ViewName[];
  for (const v of views) if (!MATCH_VIEWS.includes(v)) fail(here, `a rule cannot match on the view "${v}"`);
  if (new Set(views).size !== views.length) fail(here, 'a view is listed twice');
  if ('note' in r && typeof r.note !== 'string') fail(here, 'note must be a string');
  if ('fold' in r && r.fold !== 'cyr') fail(here, 'fold can only be "cyr"');

  let source = buildPattern(here, r.pattern, macros);
  if (r.fold === 'cyr') source = foldPattern(source);
  const re = compile(here, source);

  if (!isObject(r.examples)) return fail(here, 'examples must be an object');
  keys(`${here} examples`, r.examples, ['fire', 'quiet']);
  const fire = stringList(`${here} examples.fire`, r.examples.fire, 1, LIMITS.examples, LIMITS.exampleChars);
  const quiet = stringList(`${here} examples.quiet`, r.examples.quiet, 1, LIMITS.examples, LIMITS.exampleChars);
  // A rule without examples that prove it is a rule nobody can reason about: each must fire on its fire examples and
  // stay quiet on its quiet ones, on its own, before any other rule or the weak/strong logic is involved.
  for (const t of fire) if (!matchesOn(re, views, t)) fail(here, `its own example does not fire: ${JSON.stringify(t)}`);
  for (const t of quiet) if (matchesOn(re, views, t)) fail(here, `a quiet example fires: ${JSON.stringify(t)}`);

  return { id, category: r.category as Rule['category'], strength: r.strength as Strength, views, re };
}

function readSquashed(where: string, doc: unknown): SquashedSet[] {
  if (!isObject(doc)) return fail(where, 'must be an object');
  keys(where, doc, ['schema', 'sets']);
  if (doc.schema !== 1) fail(where, 'schema must be 1');
  if (!Array.isArray(doc.sets) || doc.sets.length > 8) return fail(where, '"sets" must be a list of at most 8');
  const out: SquashedSet[] = [];
  for (const s of doc.sets as unknown[]) {
    if (!isObject(s)) return fail(where, 'a set must be an object');
    keys(where, s, ['id', 'view', 'fold', 'parts']);
    const id = s.id;
    if (typeof id !== 'string' || !/^[a-z0-9_.]{2,60}$/.test(id)) return fail(where, `bad set id ${JSON.stringify(id)}`);
    if (s.view !== 'squashed_lat' && s.view !== 'squashed_cyr') fail(`${where} ${id}`, 'view must be squashed_lat or squashed_cyr');
    if (s.fold !== 'none' && s.fold !== 'cyr') fail(`${where} ${id}`, 'fold must be "none" or "cyr"');
    if (!Array.isArray(s.parts) || s.parts.length < 2 || s.parts.length > 6) return fail(`${where} ${id}`, 'parts must be 2 to 6 lists of words');
    let phrases = [''];
    for (const p of s.parts as unknown[]) {
      const words = stringList(`${where} ${id} parts`, p, 1, 30, 40);
      phrases = phrases.flatMap((a) => words.map((w) => a + (s.fold === 'cyr' ? foldPattern(w) : w)));
      if (phrases.length > LIMITS.squashedPhrases) fail(`${where} ${id}`, 'too many phrases');
    }
    for (const ph of phrases) {
      if (!/^[\p{L}\p{N}]+$/u.test(ph)) fail(`${where} ${id}`, `a phrase must be letters and digits only: ${JSON.stringify(ph)}`);
      if (ph.length < LIMITS.squashedMin) fail(`${where} ${id}`, `a phrase is shorter than ${LIMITS.squashedMin} characters (too many false hits): ${JSON.stringify(ph)}`);
    }
    out.push({ id, view: s.view as SquashedSet['view'], phrases: [...new Set(phrases)] });
  }
  return out;
}

/** Reads, checks and compiles the rule set in `dir`. Throws RulesetError for anything that is not exactly right. */
export function loadRuleset(dir: string): Ruleset {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    return fail(dir, `cannot read the rules directory: ${(e as Error).message}`);
  }
  if (names.length === 0 || names.length > LIMITS.files) fail(dir, `expected 1 to ${LIMITS.files} files, found ${names.length}`);
  const hash = createHash('sha256');
  const docs = new Map<string, unknown>();
  for (const name of names) {
    if (name !== 'macros.json' && name !== 'squashed.json' && !/^[a-z0-9-]+\.rules\.json$/.test(name)) fail(dir, `unexpected file "${name}"`);
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) fail(path, 'must be a regular file (no links, no directories)');
    if (st.size > LIMITS.fileBytes) fail(path, 'file is too large');
    const bytes = readFileSync(path);
    hash.update(name).update('\0').update(bytes).update('\0');
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      return fail(path, `not valid JSON: ${(e as Error).message}`);
    }
    docs.set(name, doc);
  }
  if (!docs.has('macros.json')) fail(dir, 'macros.json is missing');
  if (!docs.has('squashed.json')) fail(dir, 'squashed.json is missing');
  const macros = readMacros('macros.json', docs.get('macros.json'));
  const squashed = readSquashed('squashed.json', docs.get('squashed.json'));
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const [name, doc] of docs) {
    if (!name.endsWith('.rules.json')) continue;
    if (!isObject(doc)) return fail(name, 'must be an object');
    keys(name, doc, ['schema', 'rules']);
    if (doc.schema !== 1) fail(name, 'schema must be 1');
    if (!Array.isArray(doc.rules) || doc.rules.length === 0) return fail(name, '"rules" must be a non-empty list');
    for (const r of doc.rules as unknown[]) rules.push(readRule(name, r, macros, seen));
  }
  if (rules.length === 0 || rules.length > LIMITS.rules) fail(dir, `expected 1 to ${LIMITS.rules} rules, found ${rules.length}`);
  for (const s of squashed) if (seen.has(s.id)) fail('squashed.json', `id ${s.id} is also a rule id`);
  return { rules, squashed, hash: hash.digest('hex'), files: names };
}
