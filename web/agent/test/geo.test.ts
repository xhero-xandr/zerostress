import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeo, ipv4ToInt, loadGeo } from '../geo.ts';

const COUNTRY = ['10.0.0.0,10.0.0.255,DE', '10.0.2.0,10.0.2.255,ZZ', '10.0.1.0,10.0.1.255,US', '2001:db8::,2001:db8::ffff,FR'].join('\n');
const ASN = ['10.0.0.0,10.0.0.127,13335,"Cloudflare, Inc."', '10.0.0.128,10.0.0.255,64500,Plain Org', 'garbage', '10.0.1.0,10.0.1.255,notanumber,"X"'].join('\n');
const geo = createGeo(COUNTRY, ASN);

test('address to number only for a well-formed IPv4', () => {
  assert.equal(ipv4ToInt('0.0.0.1'), 1);
  assert.equal(ipv4ToInt('10.0.1.0'), 167772416);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  for (const bad of ['256.1.1.1', '1.1.1', '1.1.1.1.1', 'a.b.c.d', '', '::1', '1.1.1.1 ']) assert.equal(ipv4ToInt(bad), null, bad);
});

test('country and network of an address inside a range, borders included', () => {
  assert.deepEqual(geo('10.0.0.0'), { country: 'DE', asn: 13335, org: 'Cloudflare, Inc.' });
  assert.deepEqual(geo('10.0.0.127'), { country: 'DE', asn: 13335, org: 'Cloudflare, Inc.' });
  assert.deepEqual(geo('10.0.0.128'), { country: 'DE', asn: 64500, org: 'Plain Org' });
  assert.deepEqual(geo('10.0.0.255'), { country: 'DE', asn: 64500, org: 'Plain Org' });
});

test('outside every range, in a gap, or unknown: nothing is invented', () => {
  assert.deepEqual(geo('9.255.255.255'), { country: null, asn: null, org: null });
  assert.deepEqual(geo('10.0.3.0'), { country: null, asn: null, org: null });
  assert.deepEqual(geo('11.0.0.0'), { country: null, asn: null, org: null });
  assert.deepEqual(geo('2001:db8::1'), { country: null, asn: null, org: null });
  assert.deepEqual(geo('not an ip'), { country: null, asn: null, org: null });
});

test('ZZ means no country; a broken ASN number is dropped; an unsorted file still works', () => {
  assert.equal(geo('10.0.2.5').country, null);
  assert.equal(geo('10.0.1.5').country, 'US');
  assert.equal(geo('10.0.1.5').asn, null);
});

test('the owner name is cut to a short length', () => {
  const g = createGeo('10.0.0.0,10.0.0.255,DE', `10.0.0.0,10.0.0.255,1,"${'x'.repeat(500)}"`);
  assert.equal(g('10.0.0.1').org?.length, 80);
});

test('a missing database is reported as null, not as a crash', () => {
  assert.equal(loadGeo('/nonexistent-dir'), null);
});
