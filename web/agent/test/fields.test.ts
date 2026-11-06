import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_CODES, asksOf, classifyField } from '../fields.ts';

const f = (o: Record<string, unknown>) => ({ visible: true, type: 'text', name: '', label: '', autocomplete: '', password: false, ...o });

test('by type', () => {
  assert.equal(classifyField(f({ type: 'password', password: true })), 'password');
  assert.equal(classifyField(f({ type: 'email' })), 'email');
  assert.equal(classifyField(f({ type: 'tel' })), 'phone');
});

test('by the hint, the name or the label, in the languages of the pages seen', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ autocomplete: 'cc-number' }, 'card_number'], [{ name: 'card_number' }, 'card_number'], [{ label: 'Número do cartão' }, 'card_number'], [{ label: 'Credit card' }, 'card_number'],
    [{ autocomplete: 'cc-csc' }, 'card_security'], [{ name: 'cvv' }, 'card_security'], [{ label: 'Código de segurança' }, 'card_security'], [{ label: 'CVC2' }, 'card_security'],
    [{ autocomplete: 'cc-exp' }, 'card_expiry'], [{ label: 'Validade' }, 'card_expiry'], [{ label: 'Expiry date' }, 'card_expiry'], [{ label: 'MM / YY' }, 'card_expiry'],
    [{ autocomplete: 'one-time-code' }, 'one_time_code'], [{ name: 'otp' }, 'one_time_code'], [{ label: 'SMS code' }, 'one_time_code'], [{ label: 'Código de verificação' }, 'one_time_code'],
    [{ name: 'ssn' }, 'id_number'], [{ label: 'CPF' }, 'id_number'], [{ label: 'Passport number' }, 'id_number'],
    [{ name: 'dob' }, 'birth_date'], [{ label: 'Data de nascimento' }, 'birth_date'],
    [{ name: 'user_email' }, 'email'], [{ label: 'E-mail' }, 'email'], [{ label: 'Correo electrónico' }, 'email'],
    [{ name: 'mobile' }, 'phone'], [{ label: 'Telefone' }, 'phone'], [{ label: 'WhatsApp' }, 'phone'],
    [{ name: 'street' }, 'address'], [{ label: 'CEP' }, 'address'], [{ label: 'Zip code' }, 'address'], [{ label: 'Endereço' }, 'address'],
    [{ name: 'first_name' }, 'name'], [{ label: 'Card holder' }, 'name'], [{ label: 'Nome completo' }, 'name'],
  ];
  for (const [o, want] of cases) assert.equal(classifyField(f(o)), want, JSON.stringify(o));
});

test('the first matching kind wins: an email address is an email, a card security code is not a number', () => {
  assert.equal(classifyField(f({ name: 'email_address' })), 'email');
  assert.equal(classifyField(f({ label: 'Card security code' })), 'card_security');
  assert.equal(classifyField(f({ label: 'Card expiry' })), 'card_expiry');
  assert.equal(classifyField(f({ label: 'Name on card' })), 'name');
});

test('fields nobody fills in, and fields nobody can see, ask for nothing', () => {
  for (const type of ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file']) assert.equal(classifyField(f({ type, name: 'email', label: 'Email' })), null, type);
  assert.equal(classifyField(f({ type: 'password', password: true, visible: false })), null);
  assert.equal(classifyField(f({ name: 'q', label: 'Search' })), null);
  assert.equal(classifyField(f({ name: 'username', label: 'Username' })), null, 'a user name is not "a name"');
  assert.equal(classifyField(f({ label: 'Promo code' })), null, 'a code is a one-time code only when it says so');
});

test('anything that is not a field is read as nothing', () => {
  for (const v of [null, undefined, 5, 'x', [], { type: 5, name: {}, label: [] }, { type: 'text', name: 'a'.repeat(1e6) }]) assert.equal(classifyField(v), null);
  assert.deepEqual(asksOf(null), []);
  assert.deepEqual(asksOf('x'), []);
});

test('a form asks for each kind once, in a fixed order', () => {
  const login = [f({ type: 'password', password: true }), f({ type: 'email' }), f({ type: 'password', password: true }), f({ name: 'card_number' }), f({ type: 'submit' })];
  assert.deepEqual(asksOf(login), ['password', 'card_number', 'email']);
  assert.deepEqual(asksOf(login), ASK_CODES.filter((c) => asksOf(login).includes(c)), 'in the order of the list');
});

test('a form with thousands of fields is read only as far as the limit', () => {
  const many = Array.from({ length: 5000 }, (_, i) => f({ name: i < 40 ? 'x' : 'password', type: i < 40 ? 'text' : 'password', password: i >= 40 }));
  assert.deepEqual(asksOf(many), []);
});
