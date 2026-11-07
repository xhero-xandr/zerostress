import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceViews, pickShots } from '../devices.ts';
import { buildFacts } from '../facts.ts';
import { analyze } from '../signals.ts';

const ev = (kind: string, o: Record<string, unknown> = {}) => ({ type: 'evidence', v: 1, kind, t: 0, ...o });
const desktop = (url = 'https://shop.example/', password = false) => [
  ev('nav', { via: 'requested', from: '', to: url }), ev('nav', { via: 'commit', from: '', to: url }),
  ev('page', { url, title: 'Shop', text: 'x', hidden_text: { present: false, reasons: [], text: '' }, meta: [] }),
  ev('forms', { forms: password ? [{ form: 0, action: url, has_password: true, fields: [] }] : [], total: 0, loose_password_fields: 0 }),
  ev('summary', { final_url: url, nav_error: null }),
];
const dev = (device: string, o: Record<string, unknown> = {}) =>
  ev('device', { device, viewport: { width: 1, height: 1 }, final_url: 'https://shop.example/', nav_error: null, title: 'Shop', forms: 0, has_password: false, action_origins: [], text_chars: 5, file: 'aaaaaaaaaaaaaaaa.png', ...o });

test('a phone that sees the same page: nothing differs', () => {
  const v = deviceViews([...desktop(), dev('mobile'), dev('tablet')]);
  assert.deepEqual(v.map((x) => [x.device, x.differs]), [['mobile', []], ['tablet', []]]);
  assert.ok(!analyze([...desktop(), dev('mobile'), dev('tablet')]).signals.some((s) => s.id.startsWith('device_')));
});

test('a password form only on the phone is cloaking, named as the device that saw it', () => {
  const evs = [...desktop(), dev('mobile', { forms: 1, has_password: true, action_origins: ['https://evil.example'] }), dev('tablet')];
  const v = deviceViews(evs);
  assert.deepEqual(v[0]?.differs, ['password_only_here']);
  assert.deepEqual(v[0]?.action_hosts, ['evil.example']);
  const sig = analyze(evs).signals.find((s) => s.id === 'device_cloaking');
  assert.equal(sig?.level, 'high');
  assert.match(sig?.text ?? '', /as a phone;/);
  assert.doesNotMatch(sig?.text ?? '', /tablet/);
  assert.deepEqual(sig?.refs, [evs.length - 2]);
  const both = analyze([...desktop(), dev('mobile', { has_password: true }), dev('tablet', { has_password: true })]).signals.find((s) => s.id === 'device_cloaking');
  assert.match(both?.text ?? '', /a phone and a tablet/);
});

test('a sign-in form only phones see, on the site itself and an old domain, is told but not counted (TikTok, Instagram)', () => {
  const evs = [...desktop(), dev('mobile', { forms: 1, has_password: true, action_origins: ['https://shop.example', 'https://login.shop.example:443'] }), dev('tablet', { has_password: true })];
  const old = analyze(evs, { domainAgeDays: 11_000 });
  assert.ok(!old.signals.some((s) => s.id === 'device_cloaking'));
  const told = old.signals.find((s) => s.id === 'mobile_sign_in');
  assert.equal(told?.level, 'info');
  assert.match(told?.text ?? '', /a phone and a tablet/);
  assert.equal(old.verdict, 'benign', 'nothing else is off: the verdict stays where it was');
  // the same on a young domain, or with the password sent to another site, is cloaking
  assert.equal(analyze(evs, { domainAgeDays: 20 }).signals.find((s) => s.id === 'device_cloaking')?.level, 'high');
  const away = [...desktop(), dev('mobile', { forms: 1, has_password: true, action_origins: ['https://collect.evil.example'] })];
  assert.equal(analyze(away, { domainAgeDays: 11_000 }).signals.find((s) => s.id === 'device_cloaking')?.level, 'high');
  const moved = [...desktop(), dev('mobile', { has_password: true, final_url: 'https://other.example/login' })];
  assert.equal(analyze(moved, { domainAgeDays: 11_000 }).signals.find((s) => s.id === 'device_cloaking')?.level, 'high');
  // the age not known: still counted, a step lower
  assert.equal(analyze(evs).signals.find((s) => s.id === 'device_cloaking')?.level, 'medium');
});

test('one owner\'s sites under two top-level domains (vk.com, vk.ru) are not a phone sent elsewhere; a lookalike name is', () => {
  const asked = (to: string, land: string) => [
    ev('nav', { via: 'requested', from: '', to }), ev('nav', { via: 'commit', from: '', to: land }),
    ev('page', { url: land, title: 'VK', text: 'x', hidden_text: { present: false, reasons: [], text: '' }, meta: [] }),
    ev('forms', { forms: [], total: 0, loose_password_fields: 0 }), ev('summary', { final_url: land, nav_error: null }),
  ];
  const vk = [...asked('https://vk.com/', 'https://vk.ru/'), dev('mobile', { final_url: 'https://m.vk.com/' })];
  assert.ok(!analyze(vk).signals.some((s) => s.id === 'device_redirect'));
  const look = [...asked('https://vk.com/', 'https://vk.ru/'), dev('mobile', { final_url: 'https://vk.evil.example/' })];
  assert.equal(analyze(look).signals.find((s) => s.id === 'device_redirect')?.level, 'medium');
  // the same name, but neither is the domain that was asked for: still elsewhere
  const both = [...asked('https://shop.example/', 'https://vk.ru/'), dev('mobile', { final_url: 'https://vk.org/' })];
  assert.equal(analyze(both).signals.find((s) => s.id === 'device_redirect')?.level, 'medium');
});

test('a password form that the computer also shows is not cloaking', () => {
  const evs = [...desktop('https://shop.example/', true), dev('mobile', { has_password: true })];
  assert.deepEqual(deviceViews(evs)[0]?.differs, []);
  assert.ok(!analyze(evs).signals.some((s) => s.id === 'device_cloaking'));
});

test('loose password fields on the computer\'s page count as a password there', () => {
  const d = desktop().map((e) => (e.kind === 'forms' ? { ...e, loose_password_fields: 1 } : e));
  assert.deepEqual(deviceViews([...d, dev('mobile', { has_password: true })])[0]?.differs, []);
});

test('another site on a phone is a reason, the same site under another name is not', () => {
  const other = analyze([...desktop(), dev('mobile', { final_url: 'https://elsewhere.example/x' })]).signals.find((s) => s.id === 'device_redirect');
  assert.equal(other?.level, 'medium');
  assert.match(other?.text ?? '', /a phone/);
  assert.ok(!analyze([...desktop(), dev('mobile', { final_url: 'https://m.shop.example/' })]).signals.some((s) => s.id === 'device_redirect'));
});

test('a device that could not open the page is a result, not a reason', () => {
  const evs = [...desktop(), dev('mobile', { nav_error: 'timeout', final_url: '', file: null, has_password: true })];
  const v = deviceViews(evs)[0]!;
  assert.equal(v.nav_error, 'timeout');
  assert.deepEqual(v.differs, []);
  assert.equal(v.has_password, false);
  assert.ok(!analyze(evs).signals.some((s) => s.id.startsWith('device_')));
});

test('garbage: unknown devices, a second report of one device, bad file names and error codes', () => {
  const evs = [...desktop(), dev('watch'), dev('mobile', { file: '../../etc/passwd', nav_error: '<b>' }), dev('mobile', { title: 'second' }), dev('tablet', { forms: -3, action_origins: ['not a url', 7] }), ev('device', 'x' as never)];
  const v = deviceViews(evs);
  assert.deepEqual(v.map((x) => x.device), ['mobile', 'tablet']);
  assert.equal(v[0]?.file, null);
  assert.equal(v[0]?.nav_error, 'not_opened', 'an error code of the wrong shape is replaced by ours');
  assert.equal(v[0]?.title, 'Shop', 'only the first report of a device counts');
  assert.equal(v[1]?.forms, 0);
  assert.deepEqual(v[1]?.action_hosts, []);
});

test('the facts carry the devices without the file name, and say whether there is an image', () => {
  const f = buildFacts([...desktop(), dev('mobile', { has_password: true }), dev('tablet', { file: null })]);
  assert.deepEqual(f.devices.map((d) => [d.device, d.image, d.differs]), [['mobile', true, ['password_only_here']], ['tablet', false, []]]);
  assert.ok(f.devices.every((d) => !('file' in d) && !('at' in d)));
  assert.deepEqual(buildFacts([]).devices, []);
});

test('which image is which: the computer\'s is the last one that is not a device\'s; only saved images count', () => {
  const art = (name: string, mime = 'image/png') => ({ name, mime });
  const evs = [...desktop(), dev('mobile', { file: 'bbbbbbbbbbbbbbbb.png' }), dev('tablet', { file: 'cccccccccccccccc.png' })];
  assert.deepEqual(pickShots(evs, [art('aaaaaaaaaaaaaaaa.png'), art('bbbbbbbbbbbbbbbb.png'), art('cccccccccccccccc.png')]), { desktop: 'aaaaaaaaaaaaaaaa.png', mobile: 'bbbbbbbbbbbbbbbb.png', tablet: 'cccccccccccccccc.png' });
  // a session takes a later computer image: that one is shown
  assert.equal(pickShots(evs, [art('aaaaaaaaaaaaaaaa.png'), art('bbbbbbbbbbbbbbbb.png'), art('cccccccccccccccc.png'), art('dddddddddddddddd.png')]).desktop, 'dddddddddddddddd.png');
  // a device event naming an image the supervisor did not keep, or a file that is not an image
  assert.deepEqual(pickShots(evs, [art('aaaaaaaaaaaaaaaa.png'), art('cccccccccccccccc.bin', 'application/octet-stream')]), { desktop: 'aaaaaaaaaaaaaaaa.png', mobile: null, tablet: null });
  assert.deepEqual(pickShots([], []), { desktop: null, mobile: null, tablet: null });
});
