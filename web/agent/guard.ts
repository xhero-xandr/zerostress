// The small guards every module uses to read untrusted JSON (the collector's events, the model's answer, a service's
// reply): one definition for all of them, so "an object" and "a string" cannot mean two things in two files (review A2).
export type Ev = Record<string, unknown>;
export const isObj = (v: unknown): v is Ev => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
