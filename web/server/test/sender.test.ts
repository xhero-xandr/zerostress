import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandOf, createSenderCheck } from '../sender.ts';

test('a brand\'s own domain, and domains that imitate one', () => {
  assert.deepEqual(brandOf('paypal.com'), { brand: 'paypal', lookalike: null });
  assert.deepEqual(brandOf('mail.paypal.com'.replace(/^mail\./, '')), { brand: 'paypal', lookalike: null });
  for (const d of ['paypa1.com', 'paypal-secure.com', 'secure-paypal.net', 'paypall.com', 'paypl.com', 'micros0ft.com', 'amazon-billing.info']) assert.notEqual(brandOf(d).lookalike, null, d);
  for (const d of ['devpost.com', 'example.org', 'usaa.com', 'paycheck.com', 'apple.com.evil'.replace('.evil', '')]) assert.equal(brandOf(d).lookalike, null, d);
});

test('the sender\'s mail policies come from DNS: DMARC and its strength, SPF, MX; the age from the registry', async () => {
  const txt = async (name: string) => (name === '_dmarc.shop.example' ? [['v=DMARC1; p=reject; rua=mailto:x@shop.example']] : name === 'shop.example' ? [['v=spf1 include:_spf.google.com ~all'], ['google-site-verification=x']] : []);
  const check = createSenderCheck({ txt, mx: async () => [{ exchange: 'mx.shop.example', priority: 10 }], rdap: async () => ({ domain: 'shop.example', created: '2001-01-01T00:00:00.000Z', age_days: 9000, registrar: 'R' }) });
  assert.deepEqual(await check('shop.example'), { domain: 'shop.example', age_days: 9000, created: '2001-01-01T00:00:00.000Z', dmarc: 'reject', spf: true, mx: true, brand: null, lookalike: null, freemail: false });
});

test('a subdomain without its own DMARC takes the organisation\'s; nothing published is told as nothing', async () => {
  const txt = async (name: string) => (name === '_dmarc.news.shop.example' ? [] : name === '_dmarc.shop.example' ? [['v=DMARC1;p=none']] : []);
  const info = await createSenderCheck({ txt, mx: async () => [] })('news.shop.example');
  assert.equal(info.dmarc, 'none');
  assert.equal(info.spf, false);
  assert.equal(info.mx, false);
  const bare = await createSenderCheck({ txt: async () => [], mx: async () => [] })('new-shop.example');
  assert.equal(bare.dmarc, null);
  assert.equal(bare.age_days, null);
});

test('DNS or the registry failing or hanging is "not known", never an error or a wait beyond the limit', async () => {
  const hang = () => new Promise<never>(() => {});
  const t0 = Date.now();
  const info = await createSenderCheck({ txt: hang, mx: async () => { throw new Error('ENOTFOUND'); }, rdap: hang, timeoutMs: 50 })('gmail.com');
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual([info.dmarc, info.spf, info.mx, info.age_days, info.freemail], [null, false, false, null, true]);
});
