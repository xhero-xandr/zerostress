// What a form asks for, in words of our own. The collector reports each field's type, name, label and autocomplete hint,
// all of which come from the page; here they are reduced to a fixed list of kinds, so that what the report shows is
// our vocabulary and not the page's text.

export const ASK_CODES = ['password', 'card_number', 'card_security', 'card_expiry', 'one_time_code', 'id_number', 'birth_date', 'email', 'phone', 'address', 'name'] as const;
export type Ask = (typeof ASK_CODES)[number];

const NOT_ASKED = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color']);

// order matters: the first kind that matches wins ("email address" is an email, not an address)
const KINDS: Array<[Ask, RegExp]> = [
  ['card_security', /\bcvv2?\b|\bcvc2?\b|\bcsc\b|\bcid\b|security code|c[oó]digo de seguran|cc csc/],
  ['card_expiry', /cc exp|expir|vencimento|validade|\bmm ?\/ ?(yy|aa)|fecha de venc/],
  ['card_number', /cc num|card ?(number|num|no\b)|credit ?card|debit ?card|number on card|n[uú]mero (do |de la |de )?(cart|tarjet)|carte bancaire|cart[aã]o de cr/],
  ['one_time_code', /one ?time|\botp\b|\btotp\b|(verification|verify|sms|auth(entication)?|login|confirmation) code|2fa|authenticator|c[oó]digo de (verifica|confirma|sms)/],
  ['id_number', /\bssn\b|social security|passport|passaporte|national id|\bcpf\b|\bnik\b|tax id|driver'?s? licen|id number|\bdni\b|\bnin\b/],
  ['birth_date', /birth|\bdob\b|nascimento|bday|fecha de nac/],
  ['email', /e ?mail|correo/],
  ['phone', /phone|mobile|telefone|celular|\btel\b|whatsapp|tel[eé]fono/],
  ['address', /address|street|\bzip\b|postal|\bcep\b|endere[cç]o|\bcity\b|cidade|ciudad|direcci[oó]n/],
  ['name', /full ?name|first ?name|last ?name|given name|family name|surname|holder|titular|\bnome\b|apellido|\bname\b/],
];

const lower = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n).toLowerCase() : '');

/** What one field asks for, or null when it asks for nothing we have a word for (or is not something a person fills in). */
export function classifyField(field: unknown): Ask | null {
  if (typeof field !== 'object' || field === null) return null;
  const f = field as Record<string, unknown>;
  if (f.visible === false) return null;
  const type = lower(f.type, 20);
  if (NOT_ASKED.has(type)) return null;
  if (type === 'password' || f.password === true) return 'password';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  const text = `${lower(f.autocomplete, 40)} ${lower(f.name, 100)} ${lower(f.label, 100)}`.replace(/[_\-.[\]]+/g, ' ');
  for (const [kind, re] of KINDS) if (re.test(text)) return kind;
  return null;
}

/** The kinds a form asks for, each once, in the order of ASK_CODES. */
export function asksOf(fields: unknown): Ask[] {
  const found = new Set<Ask>();
  if (Array.isArray(fields)) for (const f of fields.slice(0, 40)) { const k = classifyField(f); if (k) found.add(k); }
  return ASK_CODES.filter((c) => found.has(c));
}
