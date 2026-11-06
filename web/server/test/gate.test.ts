import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAddress, GATE_TEXT, MAX_URL_LENGTH, type GateReason } from '../gate.ts';

const reason = (s: unknown): GateReason | 'ok' => {
  const r = checkAddress(s);
  return r.ok ? 'ok' : r.reason;
};

test('ordinary addresses pass and come back in the parser\'s normal form', () => {
  assert.deepEqual(checkAddress('https://example.com/a?b=1#frag'), { ok: true, url: 'https://example.com/a?b=1', host: 'example.com' });
  assert.deepEqual(checkAddress('example.com'), { ok: true, url: 'https://example.com/', host: 'example.com' });
  assert.deepEqual(checkAddress('  HTTP://Example.COM:8080/x  '), { ok: true, url: 'http://example.com:8080/x', host: 'example.com' });
  assert.equal(checkAddress('https://пример.рф/').ok, true);
  assert.equal((checkAddress('https://пример.рф/') as { host: string }).host, 'xn--e1afmkfd.xn--p1ai');
  assert.equal(reason('https://8.8.8.8/'), 'ok');
  assert.equal(reason('https://[2606:4700:4700::1111]/'), 'ok');
  assert.equal(reason('https://example.com./'), 'ok');
  assert.equal(reason('https://example.com/' + 'a'.repeat(1000)), 'ok');
});

test('the metadata address is refused in every way of writing it', () => {
  for (const a of [
    'http://169.254.169.254/', 'http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://0xa9fea9fe/',
    'http://0251.0376.0251.0376/', 'http://169.254.43518/', 'http://0xa9.0xfe.0xa9.0xfe/', 'http://169.0xfea9fe/',
    'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://169.254.169.254:80/',
    'http://169.254.169.254.:80/', 'http://[fd00:ec2::254]/',
  ]) assert.equal(reason(a), 'private_address', a);
});

test('every blocked IPv4 range is refused at both of its edges, and its neighbours are not', () => {
  const edges: Array<[string, string, string, string]> = [
    // [last address before, first inside, last inside, first after]
    ['0.255.255.255', '0.0.0.0', '0.255.255.255', '1.0.0.0'],
    ['9.255.255.255', '10.0.0.0', '10.255.255.255', '11.0.0.0'],
    ['100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0'],
    ['126.255.255.255', '127.0.0.0', '127.255.255.255', '128.0.0.0'],
    ['169.253.255.255', '169.254.0.0', '169.254.255.255', '169.255.0.0'],
    ['172.15.255.255', '172.16.0.0', '172.31.255.255', '172.32.0.0'],
    ['192.167.255.255', '192.168.0.0', '192.168.255.255', '192.169.0.0'],
    ['198.17.255.255', '198.18.0.0', '198.19.255.255', '198.20.0.0'],
  ];
  for (const [before, first, last, after] of edges) {
    assert.equal(reason(`http://${first}/`), 'private_address', first);
    assert.equal(reason(`http://${last}/`), 'private_address', last);
    // 0.0.0.0/8 starts the address space, so there is nothing before it
    if (before !== '0.255.255.255') assert.equal(reason(`http://${before}/`), 'ok', `${before} is outside`);
    assert.equal(reason(`http://${after}/`), 'ok', `${after} is outside`);
  }
  for (const a of ['224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.9']) {
    assert.equal(reason(`http://${a}/`), 'private_address', a);
  }
});

test('IPv6 is an allow-list: everything but plain global unicast is refused', () => {
  for (const a of ['[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]', '[ff02::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]',
    '[2002:7f00:1::]', '[2002:a9fe:a9fe::1]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]', '[2001:db8::1]', '[64:ff9b::7f00:1]', '[100::1]', '[1::1]']) {
    assert.equal(reason(`http://${a}/`), 'private_address', a);
  }
  assert.equal(reason('http://[3fff::1]/'), 'ok');
});

test('names that mean "this machine" or "inside" are refused', () => {
  for (const a of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'printer.local', 'db.internal', 'x.localdomain', 'router.lan', 'nas.home', 'intra.corp', 'wiki.intranet', '1.0.0.127.in-addr.arpa']) {
    assert.equal(reason(`http://${a}/`), 'private_address', a);
  }
  for (const a of ['intranet', 'metadata', 'foo']) assert.equal(reason(`http://${a}/`), 'bad_host', a);
});

test('other schemes, odd forms and address tricks are refused', () => {
  for (const a of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://example.com/', 'mailto:a@b.c', 'blob:https://example.com/x', 'about:blank', 'view-source:https://example.com/', 'ws://example.com/', 'tel:+1555']) {
    assert.equal(reason(a), 'bad_scheme', a);
  }
  assert.equal(reason('http://user:pass@example.com/'), 'credentials');
  assert.equal(reason('http://user@example.com/'), 'credentials');
  assert.equal(reason('http://@example.com/'), 'ok');
  for (const a of ['http://example.com:22/', 'http://example.com:3306/', 'http://example.com:9000/', 'https://example.com:80443/']) assert.equal(reason(a) === 'bad_port' || reason(a) === 'bad_url', true, a);
  for (const p of ['80', '443', '8080', '8443']) assert.equal(reason(`https://example.com:${p}/`), 'ok', p);
});

test('control characters, spaces and invisible characters are refused', () => {
  for (const a of ['https://exa mple.com/', 'https://example.com/a\nb', 'https://example.com/\u0000a', 'https://exam​ple.com/', 'https://example.com/‮a', 'https://example.com/a b',
    'https://example­.com/', 'https://example.com/﻿a', 'https://example.com/a\tb']) {
    assert.equal(reason(a), 'bad_url', JSON.stringify(a));
  }
  // whitespace around the whole text is the person's paste, not part of the address
  assert.equal(reason(' \n https://example.com/ \t'), 'ok');
  assert.equal(reason(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`), 'bad_url');
  assert.equal(reason('https://example.com/' + 'a'.repeat(MAX_URL_LENGTH - 20)), 'ok');
});

test('not a string, empty, or not an address', () => {
  for (const a of [undefined, null, 5, {}, [], '', '   ', 'http://', 'https://?', ':::', 'https://']) assert.notEqual(reason(a), 'ok', String(a));
});

test('every refusal has a sentence of ours, and none repeats the address', () => {
  const reasons: GateReason[] = ['bad_url', 'bad_scheme', 'credentials', 'bad_port', 'bad_host', 'private_address'];
  for (const r of reasons) {
    assert.ok(GATE_TEXT[r].length > 20, r);
    assert.ok(!/169\.254|localhost|javascript/i.test(GATE_TEXT[r]), r);
  }
});
