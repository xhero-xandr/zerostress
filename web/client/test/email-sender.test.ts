import { expect, test } from 'vitest';
import type { SenderInfo } from '../src/api.ts';
import { claimedBrand, senderWarnings } from '../src/email-sender.tsx';

const S = (o: Partial<SenderInfo>): SenderInfo => ({ domain: 'shop.example', age_days: 9000, created: null, dmarc: 'reject', spf: true, mx: true, brand: null, lookalike: null, freemail: false, ...o });
const ids = (s: SenderInfo, name: string | null) => senderWarnings(s, name).map((w) => `${w.id}:${w.level}`);

test('the brand a sender\'s name claims: whole words only', () => {
  expect(claimedBrand('PayPal Service')).toBe('paypal');
  expect(claimedBrand('Microsoft 365 Team')).toBe('microsoft');
  expect(claimedBrand('Cassie B')).toBeNull();
  expect(claimedBrand('Applebee\'s')).toBeNull();
  expect(claimedBrand(null)).toBeNull();
});

test('an honest old sender with a strict policy: nothing to warn about', () => {
  expect(ids(S({}), 'Cassie B')).toEqual([]);
  expect(ids(S({ domain: 'paypal.com', brand: 'paypal' }), 'PayPal')).toEqual([]);
});

test('lookalikes, a brand claimed from someone else\'s domain or a free mailbox, young domains, no policy', () => {
  expect(ids(S({ domain: 'paypa1.com', lookalike: 'paypal' }), 'PayPal')).toEqual(['sender_lookalike:high']);
  expect(ids(S({}), 'PayPal Billing')).toEqual(['sender_claims_brand:high']);
  expect(ids(S({ domain: 'gmail.com', freemail: true, dmarc: 'none' }), 'Amazon Support')).toEqual(['sender_freemail_brand:high']);
  expect(ids(S({ age_days: 5 }), null)).toEqual(['sender_young:high']);
  expect(ids(S({ age_days: 100 }), null)).toEqual(['sender_young:medium']);
  expect(ids(S({ dmarc: null, spf: false }), null)).toEqual(['sender_no_policy:medium']);
  expect(ids(S({ domain: 'gmail.com', freemail: true, dmarc: null, spf: false }), 'Alice')).toEqual([]);
});
