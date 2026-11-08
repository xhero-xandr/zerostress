import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimiter, DEFAULT_LIMITS } from '../limits.ts';

const make = (over = {}) => {
  let t = 1_000_000;
  const l = createLimiter({ ...DEFAULT_LIMITS, chatPerHour: 3, chatPerReport: 2, ...over }, () => t);
  return { l, tick: (ms: number) => { t += ms; } };
};

test('chat: one call at a time per person, and the slot comes back when released (once)', () => {
  const { l } = make();
  const a = l.chat('1.1.1.1', 'r1', true);
  assert.ok(a.ok);
  const again = l.chat('1.1.1.1', 'r1', true);
  assert.deepEqual(again.ok ? null : again.reason, 'chat_busy');
  assert.ok(l.chat('2.2.2.2', 'r1', false).ok, 'another person is not blocked');
  if (a.ok) { a.release(); a.release(); }
  assert.ok(l.chat('1.1.1.1', 'r1', false).ok);
});

test('chat: so many a person per hour, counted from the first, and the wait is told', () => {
  const { l, tick } = make();
  for (let i = 0; i < 3; i++) {
    const s = l.chat('1.1.1.1', `r${i}`, false);
    assert.ok(s.ok, String(i));
    if (s.ok) s.release();
    tick(60_000);
  }
  const no = l.chat('1.1.1.1', 'r9', false);
  assert.ok(!no.ok);
  if (!no.ok) { assert.equal(no.reason, 'chat_rate'); assert.equal(no.retryAfterS, 3600 - 180); }
  tick(3600_000 - 179_000);
  const yes = l.chat('1.1.1.1', 'r9', false);
  assert.ok(yes.ok, 'the first call has left the hour');
});

test('chat: a report takes only so many questions from everybody, and the explanation takes none', () => {
  const { l } = make({ chatPerHour: 100 });
  for (const who of ['a', 'b']) {
    const s = l.chat(who, 'rep', true);
    assert.ok(s.ok);
    if (s.ok) s.release();
  }
  const third = l.chat('c', 'rep', true);
  assert.ok(!third.ok && third.reason === 'chat_cap');
  const explain = l.chat('c', 'rep', false);
  assert.ok(explain.ok, 'the explanation is not a question');
  if (explain.ok) explain.release();
  const other = l.chat('c', 'another-report', true);
  assert.ok(other.ok, 'another report has its own allowance');
});

test('chat: many explanations never eat into the question allowance', () => {
  const { l } = make({ chatPerHour: 100 });
  for (let i = 0; i < 5; i++) {
    const s = l.chat(`p${i}`, 'rep2', false);
    assert.ok(s.ok, String(i));
    if (s.ok) s.release();
  }
  for (const who of ['a', 'b']) {
    const s = l.chat(who, 'rep2', true);
    assert.ok(s.ok, 'the report still has its full question allowance');
    if (s.ok) s.release();
  }
  const third = l.chat('c', 'rep2', true);
  assert.ok(!third.ok && third.reason === 'chat_cap');
});

test('chat: a refused call uses up nothing', () => {
  const { l } = make({ chatPerReport: 1 });
  const first = l.chat('a', 'rep', true);
  if (first.ok) first.release();
  for (let i = 0; i < 5; i++) assert.ok(!l.chat('a', 'rep', true).ok);
  const fresh = l.chat('a', 'rep', false);
  assert.ok(fresh.ok, 'the refusals did not count against the hour');
});

test('a client whose windows have all run out is forgotten: the limiter does not grow with every address (review)', () => {
  let t = 1_000_000;
  const l = createLimiter({ ...DEFAULT_LIMITS, dailyCap: 10_000 }, () => t);
  for (let i = 0; i < 500; i++) {
    const s = l.start(`10.0.${i >> 8}.${i & 255}`);
    if (s.ok) s.release();
    l.badKey(`10.1.${i >> 8}.${i & 255}`);
    const c = l.chat(`10.2.${i >> 8}.${i & 255}`, 'r', false);
    if (c.ok) c.release();
  }
  assert.equal(l.tracked(), 1500);
  t += 2 * 60_000; // the bad keys' minute is over
  l.badKey('10.9.0.1');
  assert.equal(l.tracked(), 1001, 'the bad keys of a minute ago are forgotten, today\'s starts and chats are not');
  t += 2 * 3_600_000; // the chats' hour too
  l.badKey('10.9.0.2');
  assert.equal(l.tracked(), 501);
  t += 86_400_000; // and the starts' day
  l.badKey('10.9.0.3');
  assert.equal(l.tracked(), 1);
  const again = l.start('10.0.0.1');
  assert.equal(again.ok, true, 'a forgotten client starts afresh');
});
