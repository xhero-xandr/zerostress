import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRdap, rdapName, type Fetcher } from '../rdap.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const BOOT = { services: [[['si', 'com'], ['https://rdap.example.si/']], [['evil'], ['http://plain.example/']], [['ip'], ['https://127.0.0.1/']]] };
const DOMAIN = {
  events: [{ eventAction: 'last changed', eventDate: '2026-05-11T00:00:00Z' }, { eventAction: 'registration', eventDate: '2011-06-17T00:00:00Z' }],
  entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Not this']]] }, { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'AOI d.o.o.']]] }],
};

function fake(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const body = handlers[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
  return { fetcher, calls };
}

test('names fit for a request: ascii domains only, never an address', () => {
  assert.equal(rdapName('Decathlon.SI.'), 'decathlon.si');
  assert.equal(rdapName('bücher.de'), 'xn--bcher-kva.de');
  for (const bad of ['', 'localhost', '1.2.3.4', 'a b.com', 'a/b.com', 'x.com/../y', '-a.com', 'a..com', '[::1]', 'a.com:8080', '10.20.30.40', '192.168.100.200']) assert.equal(rdapName(bad), null, bad);
});

test('registration date, age in days and registrar from the registry; only the domain name is sent', async () => {
  const { fetcher, calls } = fake({ 'https://data.iana.org/rdap/dns.json': BOOT, 'https://rdap.example.si/domain/decathlon.si': DOMAIN });
  const info = await createRdap({ fetcher, now: () => NOW })('decathlon.si');
  assert.deepEqual(info, { domain: 'decathlon.si', created: '2011-06-17T00:00:00.000Z', age_days: 5620, registrar: 'AOI d.o.o.' });
  assert.deepEqual(calls, ['https://data.iana.org/rdap/dns.json', 'https://rdap.example.si/domain/decathlon.si']);
});

test('a date in the future is not believed; a missing registrar is null', async () => {
  const { fetcher } = fake({ 'https://data.iana.org/rdap/dns.json': BOOT, 'https://rdap.example.si/domain/x.si': { events: [{ eventAction: 'registration', eventDate: '2030-01-01T00:00:00Z' }] } });
  assert.deepEqual(await createRdap({ fetcher, now: () => NOW })('x.si'), { domain: 'x.si', created: null, age_days: null, registrar: null });
});

test('the bootstrap and the answers are remembered', async () => {
  const { fetcher, calls } = fake({ 'https://data.iana.org/rdap/dns.json': BOOT, 'https://rdap.example.si/domain/a.si': DOMAIN, 'https://rdap.example.si/domain/b.com': DOMAIN });
  const rdap = createRdap({ fetcher, now: () => NOW });
  await rdap('a.si'); await rdap('a.si'); await rdap('b.com');
  assert.equal(calls.filter((c) => c.includes('dns.json')).length, 1);
  assert.equal(calls.filter((c) => c.endsWith('/a.si')).length, 1);
});

test('no registry for the zone, a plain-http or numeric registry address, an error, a timeout: all give null', async () => {
  // the unsafe registries WOULD answer with a registration date if they were used
  const { fetcher } = fake({ 'https://data.iana.org/rdap/dns.json': BOOT, 'http://plain.example/domain/a.evil': DOMAIN, 'https://127.0.0.1/domain/a.ip': DOMAIN });
  const rdap = createRdap({ fetcher, now: () => NOW });
  assert.equal(await rdap('a.zz'), null);
  assert.equal(await rdap('a.evil'), null);
  assert.equal(await rdap('a.ip'), null);
  assert.equal(await rdap('a.si'), null); // registry answers 404
  const slow: Fetcher = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  assert.equal(await createRdap({ fetcher: slow, timeoutMs: 20 })('a.si'), null);
  const broken: Fetcher = async () => { throw new Error('network'); };
  assert.equal(await createRdap({ fetcher: broken })('a.si'), null);
});

test('a failure is not remembered', async () => {
  let fail = true;
  const inner = fake({ 'https://data.iana.org/rdap/dns.json': BOOT, 'https://rdap.example.si/domain/a.si': DOMAIN }).fetcher;
  const fetcher: Fetcher = async (u, i) => { if (fail) throw new Error('down'); return inner(u, i); };
  const rdap = createRdap({ fetcher, now: () => NOW });
  assert.equal(await rdap('a.si'), null);
  fail = false;
  assert.equal((await rdap('a.si'))?.registrar, 'AOI d.o.o.');
});
