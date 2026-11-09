// How widely visited a site is, from the top of the Tranco list kept on the host (https://tranco-list.eu, fetched by
// tools/fetch-tranco.mjs). Nothing leaves the machine at lookup time. The rank says whose address this is, never that
// a page on it is safe: the rules only mention it, they never lower a verdict because of it.

import { readFileSync } from 'node:fs';
import { isIpHost, registrable } from './domain.ts';

/** the rank of a site (1 is the most visited), or null when it is not on the list or the address is not a site's own */
export type PopularityLookup = (host: string) => number | null;

export const POPULARITY_FILE = 'top-100k.txt';
const MAX_ROWS = 100_000;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** One name per line, the first line is rank 1. A line that is not a name keeps its rank but is skipped. */
export function parsePopularity(text: string): Map<string, number> {
  const ranks = new Map<string, number>();
  const lines = text.split('\n', MAX_ROWS);
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i]!.trim().toLowerCase();
    if (NAME.test(name) && !ranks.has(name)) ranks.set(name, i + 1);
  }
  return ranks;
}

export function popularityOf(ranks: ReadonlyMap<string, number>): PopularityLookup {
  return (host) => {
    const h = host.toLowerCase().replace(/\.$/, '');
    if (isIpHost(h)) return null;
    // a name on a free hosting service is a site of its own to registrable(): alice.github.io is not github.io
    const site = registrable(h);
    // the site's own address, not a name on it: s3.amazonaws.com is a place where anyone keeps files, and
    // docs.google.com is a place where anyone publishes a form
    if (h !== site && h !== `www.${site}`) return null;
    return ranks.get(site) ?? null;
  };
}

/** The list of the host, or null when it is missing or empty: the report then says nothing about popularity. */
export function loadPopularity(dir: string): PopularityLookup | null {
  try {
    const ranks = parsePopularity(readFileSync(`${dir}/${POPULARITY_FILE}`, 'utf8'));
    return ranks.size >= 1000 ? popularityOf(ranks) : null;
  } catch {
    return null;
  }
}

/** The step the rank falls in; a rank is not worth more precision than that. */
export function rankStep(rank: number): 1000 | 10_000 | 100_000 {
  return rank <= 1000 ? 1000 : rank <= 10_000 ? 10_000 : 100_000;
}
