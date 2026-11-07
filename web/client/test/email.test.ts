import { describe, expect, test } from 'vitest';
import { isEmailSource, linksToCheck, looksLikeEmail, readEmail } from '../src/email.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
const ids = (raw: string) => readEmail(raw).warnings.map((w) => w.id);

/** The source of a phishing email as Gmail's "Show original" gives it: CRLF, MIME parts in base64 and quoted-printable. */
const PHISH = [
  'Delivered-To: me@gmail.example',
  'Received: by 2002:a05:6a10:1234 with SMTP id x; Sat, 7 Nov 2026 10:00:00 -0800 (PST)',
  'Authentication-Results: mx.google.com;',
  '       dkim=fail header.i=@paypal.com header.s=s1;',
  '       spf=softfail (google.com: domain of transitioning alerts@secure-paypa1.test does not designate 203.0.113.9 as permitted sender) smtp.mailfrom=alerts@secure-paypa1.test;',
  '       dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=paypal.com',
  'Authentication-Results: forged.example; spf=pass; dkim=pass; dmarc=pass',
  'From: "service@paypal.com" <alerts@secure-paypa1.test>',
  'Reply-To: help-desk@other-mail.test',
  `Subject: =?UTF-8?B?${Buffer.from('Ваш счёт заблокирован').toString('base64')}?=`,
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix-1"',
  '',
  '--mix-1',
  'Content-Type: multipart/alternative; boundary=alt-2',
  '',
  '--alt-2',
  'Content-Type: text/plain; charset="UTF-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Your account is on hold. Verify here: https://secure-paypa1.test/verify?id=3D7&amp;x=',
  '=3D1',
  '--alt-2',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<p>Your account is on hold.</p><a href="https://secure-paypa1.test/login?s=1">https://www.paypal.com/signin</a> <a href="https://www.paypal.com/help">Help</a>'),
  '--alt-2--',
  '--mix-1',
  'Content-Type: text/html; name="Invoice.pdf.html"',
  'Content-Disposition: attachment; filename="Invoice.pdf.html"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<form action="https://evil.test/steal"><input type=password></form>'),
  '--mix-1--',
  '',
].join('\r\n');

const GOOD = [
  'Received: from mail.shop.example by mx.example',
  'Authentication-Results: mx.google.com; dkim=pass header.i=@shop.example; spf=pass smtp.mailfrom=news@mail.shop.example; dmarc=pass (p=NONE) header.from=shop.example',
  'From: Shop <news@shop.example>',
  'Reply-To: support@help.shop.example',
  'Subject: Your order has shipped',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<a href=3D"https://shop.example/orders/42">Track your order</a>',
].join('\n');

describe('the source of an email', () => {
  test('a phishing email: every part decoded, links found, the forged sender and the web-page attachment named', () => {
    const m = readEmail(PHISH);
    expect(m.source).toBe(true);
    expect(m.from).toEqual({ name: 'service@paypal.com', address: 'alerts@secure-paypa1.test' });
    expect(m.replyTo).toBe('help-desk@other-mail.test');
    expect(m.subject).toBe('Ваш счёт заблокирован');
    // the topmost Authentication-Results is the receiving server's; a "pass" the sender wrote further down is not taken
    expect(m.auth).toEqual({ spf: 'softfail', dkim: 'fail', dmarc: 'fail' });
    expect(m.links.map((l) => [l.url, l.shown])).toEqual([
      ['https://secure-paypa1.test/login?s=1', 'https://www.paypal.com/signin'],
      ['https://www.paypal.com/help', null],
      ['https://secure-paypa1.test/verify?id=7&amp;x=1', null],
    ]);
    expect(m.attachments).toEqual([{ name: 'Invoice.pdf.html', type: 'text/html', risk: 'web_page' }]);
    expect(ids(PHISH)).toEqual(['auth_failed', 'reply_elsewhere', 'name_shows_other_address', 'attachment_web_page', 'link_text_elsewhere']);
    // the attachment is listed, never read for links: a form inside it is not a link to check
    expect(m.links.some((l) => l.host === 'evil.test')).toBe(false);
  });

  test('an honest newsletter: the sender checks passed, replies stay on its own domain, no warnings', () => {
    const m = readEmail(GOOD);
    expect(m.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(m.links.map((l) => l.url)).toEqual(['https://shop.example/orders/42']);
    expect(m.warnings).toEqual([]);
  });

  test('no check passed at all: the sender is unconfirmed, not called forged', () => {
    const src = GOOD.replace(/dkim=pass/, 'dkim=none').replace(/spf=pass/, 'spf=neutral').replace(/dmarc=pass/, 'dmarc=none');
    expect(ids(src)).toEqual(['auth_unconfirmed']);
  });

  test('a sender name with a brand but no address of its own is not a warning; one with another address is', () => {
    expect(ids(GOOD.replace('From: Shop <', 'From: "Shop.example Team" <'))).toEqual([]);
    expect(ids(GOOD.replace('From: Shop <', 'From: "Apple Support" <'))).toEqual([]);
    expect(ids(GOOD.replace('From: Shop <', 'From: "support@apple.com" <'))).toEqual(['name_shows_other_address']);
  });

  test('attachments: programs, macros and archives, also with an RFC 2231 name; never more than listed', () => {
    const att = (name: string, type = 'application/octet-stream') => [
      '--b', `Content-Type: ${type}`, `Content-Disposition: attachment; ${name}`, 'Content-Transfer-Encoding: base64', '', 'AAAA'].join('\n');
    const src = ['From: a@x.example', 'Subject: files', 'Content-Type: multipart/mixed; boundary=b', '',
      '--b', 'Content-Type: text/plain', '', 'see attached',
      att(`filename*=utf-8''%D0%A1%D1%87%D1%91%D1%82.pdf.exe`), att('filename="report.xlsm"'), att('filename="docs.zip"', 'application/zip'), att('filename="photo.jpg"', 'image/jpeg'), '--b--'].join('\n');
    const m = readEmail(src);
    expect(m.attachments.map((a) => [a.name, a.risk])).toEqual([['Счёт.pdf.exe', 'program'], ['report.xlsm', 'macros'], ['docs.zip', 'archive'], ['photo.jpg', null]]);
    expect(m.warnings.map((w) => [w.id, w.level])).toEqual([['attachment_program', 'high'], ['attachment_macros', 'high'], ['attachment_archive', 'medium']]);
  });

  test('a forwarded email (message/rfc822): the links inside it are found too', () => {
    const inner = ['From: Bank <a@bank.example>', 'Subject: inner', 'Content-Type: text/html', '', '<a href="https://inner-phish.test/">https://bank.example/</a>'].join('\n');
    const src = ['From: friend@x.example', 'Subject: Fwd: inner', 'Content-Type: multipart/mixed; boundary=f', '', '--f', 'Content-Type: text/plain', '', 'look at this', '--f', 'Content-Type: message/rfc822', '', inner, '--f--'].join('\n');
    expect(readEmail(src).links.map((l) => [l.url, l.shown])).toEqual([['https://inner-phish.test/', 'https://bank.example/']]);
  });

  test('a charset other than UTF-8 is decoded by its name', () => {
    const src = ['From: a@x.example', 'Subject: x', 'Content-Type: text/plain; charset=windows-1251', 'Content-Transfer-Encoding: base64', '',
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20]).toString('base64') + Buffer.from('https://x.example/').toString('base64')].join('\n');
    // two base64 runs glued together are not valid base64 in general; one run is
    const one = ['From: a@x.example', 'Subject: x', 'Content-Type: text/plain; charset=windows-1251', 'Content-Transfer-Encoding: base64', '',
      Buffer.concat([Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20]), Buffer.from('https://x.example/a')]).toString('base64')].join('\n');
    expect(readEmail(one).links.map((l) => l.url)).toEqual(['https://x.example/a']);
    expect(() => readEmail(src)).not.toThrow();
  });

  test('a broken or hostile source does not break the reader', () => {
    for (const bad of ['From: a@b\nSubject: x\nContent-Type: multipart/mixed\n\nno boundary', 'From: a@b\nSubject: x\nContent-Transfer-Encoding: base64\n\n!!!not base64!!!', `From: a@b\nSubject: x\nContent-Type: multipart/mixed; boundary=x\n\n${'--x\nContent-Type: multipart/mixed; boundary=x\n\n'.repeat(50)}`]) {
      expect(() => readEmail(bad)).not.toThrow();
    }
  });
});

describe('the text of an email, not its source', () => {
  test('links are found, and it says that the sender can only be checked from the source', () => {
    const m = readEmail('Hello,\n<a href="https://paypa1.test/">www.paypal.com</a>');
    expect(m.source).toBe(false);
    expect(m.auth).toBeNull();
    expect(m.links.map((l) => l.host)).toEqual(['paypa1.test']);
    expect(m.warnings.map((w) => w.id)).toEqual(['link_text_elsewhere']);
  });
});

test('pasted text is an email when it is a source, or has links and some length; not a short question', () => {
  expect(looksLikeEmail('Is it safe to enter my card here?')).toBe(false);
  expect(looksLikeEmail('https://a.example/')).toBe(false);
  expect(looksLikeEmail('Is https://a.example/ safe?')).toBe(false);
  expect(looksLikeEmail('Hello,\nplease pay: https://a.example/pay')).toBe(true);
  expect(looksLikeEmail('see https://a.example/ and https://b.example/')).toBe(true);
  expect(looksLikeEmail(`${'Dear customer, '.repeat(20)} https://a.example/`)).toBe(true);
  expect(looksLikeEmail('Hello,\nno links at all\nin this one')).toBe(false);
  // the source of an email is one, even when its links are hidden in base64 parts
  expect(looksLikeEmail(PHISH)).toBe(true);
  expect(isEmailSource('Subject: hi\nFrom: a@b.example\n\nbody')).toBe(true);
  expect(isEmailSource('Note: this is not\nan email: really')).toBe(false);
});

test('the links for the whole email: unsubscribe and preference links are left out, at most ten', () => {
  const links = readEmail(['https://a.example/x', 'https://news.example/api/mailings/unsubscribe/abc', 'https://b.example/opt-out?u=1', 'https://c.example/email-preferences', ...Array.from({ length: 12 }, (_, i) => `https://s${i}.example/`)].join('\n')).links;
  const picked = linksToCheck(links);
  expect(picked[0]).toBe('https://a.example/x');
  expect(picked.some((u) => /unsubscribe|opt-out|preferences/.test(u))).toBe(false);
  expect(picked).toHaveLength(10);
});
