import { createHash } from 'node:crypto';
import { constants, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { LIMITS, cut } from './limits.mjs';

// Static analysis of a downloaded file, inside the guest. The file is hostile: every parser is bounded in what it reads,
// inflates and walks, works on truncated input and never throws out of analyzeFile.

const MiB = 1024 * 1024;

export const FILE_LIMITS = Object.freeze({
  links: 20,
  entries: 30,
  entryNameChars: 200,
  forms: 10,
  detailChars: 200,
  titleChars: 300,
  filenameChars: 255,
  mimeChars: 100,
  urlChars: LIMITS.urlChars,
  archiveEntries: 10_000,
  partsRead: 300,
  entryInflateBytes: 8 * MiB,
  totalInflateBytes: 32 * MiB,
  // A bomb that overflows its output buffer is retried on this much of its input, enough for a header or a tar listing.
  headInputBytes: 4096,
  pdfStreams: 5000,
  pdfNames: 4_000_000,
  textBytes: 16 * MiB,
  htmlTags: 200_000,
  tagChars: 8192,
  scriptChars: 4 * MiB,
  ovbaContainers: 200,
  ovbaOutBytes: MiB,
  ovbaTotalBytes: 8 * MiB,
  pdfStringChars: 4096,
  pdfStringBudget: 4 * MiB,
});

export const FINDING_IDS = Object.freeze([
  'macros', 'auto_exec', 'external_template', 'ole_object', 'dde',
  'pdf_javascript', 'pdf_open_action', 'pdf_launch', 'pdf_embedded_file', 'pdf_submit_form', 'pdf_encrypted',
  'archive_executable', 'archive_encrypted', 'nested_archive',
  'html_password_form', 'html_form_elsewhere', 'html_obfuscated_script', 'html_redirect', 'html_smuggling',
  'svg_script', 'executable', 'script_file', 'shortcut', 'disk_image',
]);

const words = (s) => new Set(s.split(' '));
const SCRIPT_EXT = words('js jse vbs vbe wsf hta ps1 bat cmd sh');
const EXEC_EXT = new Set([...SCRIPT_EXT, ...words('exe scr com pif cpl dll msi msp wsh psm1 jar reg chm lnk url scf iso img vhd vhdx appx msix appxbundle xll')]);
const ARCHIVE_EXT = words('zip rar 7z gz tgz tar bz2 xz cab arj ace lzh z zst');
const DECOY_EXT = words('pdf doc docx docm xls xlsx xlsm ppt pptx rtf txt csv odt ods jpg jpeg png gif bmp tif tiff mp3 mp4 wav avi mov htm html zip rar eml msg');
const ARCHIVE_TYPES = words('zip rar 7z gzip iso');
const EXEC_TYPES = words('pe elf macho lnk');

// What a name's extension claims the content is.
const EXPECTED = new Map();
for (const [types, exts] of [
  ['pdf', 'pdf'],
  ['ooxml', 'docx docm dotx dotm xlsx xlsm xltx xltm xlsb xlam pptx pptm potx potm ppsx ppsm'],
  ['odf', 'odt ods odp odg ott'],
  ['ole', 'doc dot xls xlt ppt pps pot msg msi'],
  ['zip ooxml odf', 'zip'],
  ['zip', 'jar apk'],
  ['rar', 'rar'],
  ['7z', '7z'],
  ['gzip', 'gz tgz'],
  ['html', 'htm html xhtml shtml'],
  ['svg', 'svg'],
  ['pe', 'exe dll scr cpl sys ocx'],
  ['pe other', 'com'],
  ['elf', 'so elf'],
  ['macho', 'dylib'],
  ['script', 'js jse vbs vbe wsf hta ps1 bat cmd sh'],
  ['lnk', 'lnk'],
  ['iso', 'iso vhd vhdx'],
  ['iso other', 'img dmg'],
  ['image', 'png jpg jpeg gif bmp webp ico'],
  ['text', 'txt csv log md json rtf ini'],
  ['text html svg', 'xml'],
  ['text html', 'eml'],
]) for (const e of exts.split(' ')) EXPECTED.set(e, types.split(' '));

/** Analyses one file. Always returns the event fields; what a broken parser could not finish is marked truncated. */
export function analyzeFile({ name, mime, data } = {}) {
  const buf = toBuffer(data);
  const filename = cut(typeof name === 'string' ? name : '', FILE_LIMITS.filenameChars);
  const out = {
    filename,
    mime: cut(typeof mime === 'string' ? mime : '', FILE_LIMITS.mimeChars),
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    // not "type": the event envelope owns that name (lib/emitter.mjs)
    file_type: 'other',
    ext_mismatch: false,
    double_extension: false,
    findings: [],
    links: [],
    truncated: false,
  };
  const ctx = newContext();
  const ext = extOf(filename);
  try {
    out.double_extension = isDoubleExtension(filename);
    ctx.type = detectType(buf, ext);
    ANALYZERS[ctx.type]?.(buf, ctx, ext);
  } catch {
    ctx.truncated = true;
  }
  out.file_type = ctx.type ?? 'other';
  out.ext_mismatch = buf.length > 0 && EXPECTED.has(ext) && !EXPECTED.get(ext).includes(out.file_type);
  out.findings = [...ctx.findings].map(([id, detail]) => ({ id, detail }));
  out.links = ctx.links;
  if (ctx.entries) {
    out.entries = ctx.entries;
    out.entries_total = ctx.entriesTotal;
  }
  if (ctx.html && (out.file_type === 'html' || out.file_type === 'svg')) out.html = ctx.html;
  out.truncated = ctx.truncated;
  return out;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.alloc(0);
}

function newContext() {
  const ctx = {
    type: null,
    findings: new Map(),
    links: [],
    seen: new Set(),
    entries: null,
    entriesTotal: 0,
    html: null,
    truncated: false,
    inflated: 0,
    parts: 0,
    pdfNames: 0,
    pdfStringRead: 0,
    ovbaOut: 0,
    add(id, detail = '') {
      if (!ctx.findings.has(id)) ctx.findings.set(id, cut(oneLine(detail), FILE_LIMITS.detailChars));
    },
    /** Records an absolute http(s) address; returns false once the list is full. */
    link(raw) {
      const href = normalizeUrl(raw);
      if (!href || ctx.seen.has(href)) return ctx.links.length < FILE_LIMITS.links;
      if (ctx.links.length >= FILE_LIMITS.links) {
        ctx.truncated = true;
        return false;
      }
      ctx.seen.add(href);
      ctx.links.push(href);
      return true;
    },
    entry(name) {
      ctx.entries ??= [];
      ctx.entriesTotal += 1;
      if (ctx.entries.length < FILE_LIMITS.entries) ctx.entries.push(cut(name, FILE_LIMITS.entryNameChars));
      else ctx.truncated = true;
    },
  };
  return ctx;
}

/** A part of the analysis that fails on a broken file loses only its own result. */
function guard(ctx, fn) {
  try {
    fn();
  } catch {
    ctx.truncated = true;
  }
}

const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

const TRAILING = new Set([...'.,;:!?\'"`)]}>*']);
function normalizeUrl(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length > 2 * FILE_LIMITS.urlChars) s = s.slice(0, 2 * FILE_LIMITS.urlChars);
  let end = s.length;
  while (end > 0 && TRAILING.has(s[end - 1])) end -= 1;
  s = s.slice(0, end);
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return '';
    return cut(u.href, FILE_LIMITS.urlChars);
  } catch {
    return '';
  }
}

function hostOf(target) {
  const s = String(target ?? '').trim();
  try {
    const h = new URL(s).hostname;
    if (h) return h;
  } catch { /* not a URL */ }
  const unc = /^(?:file:\/*)?\\\\([^\\/]{1,253})/i.exec(s);
  return unc ? unc[1] : '';
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>()[\]{}\\^`|]{1,2048}/gi;
function plainUrls(s, ctx) {
  const re = new RegExp(URL_IN_TEXT);
  let m;
  while ((m = re.exec(s))) if (!ctx.link(m[0])) return;
}

// ---- names --------------------------------------------------------------------------------------------------------

/** The extension Windows would act on: trailing dots and spaces are dropped. */
export function extOf(name) {
  const s = String(name ?? '').replace(/[\s.]+$/u, '');
  const dot = s.lastIndexOf('.');
  if (dot < 0 || dot === s.length - 1) return '';
  const ext = s.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

// Padding between the decoy and the real extension: spaces, dots, underscores, dashes, invisible and wide spaces.
const DOUBLE_EXT = /\.([a-z0-9]{2,5})[\s._\-\u00a0\u2000-\u200f\u2028-\u202f\u205f\u3000\u180e\ufeff]*\.([a-z0-9]{2,5})$/iu;
export function isDoubleExtension(name) {
  const s = String(name ?? '').slice(-300);
  // a right-to-left override (U+202E) shows "invoice<RLO>fdp.exe" as "invoiceexe.pdf": the same disguise
  if (/[\u202e\u202d\u2066-\u2069]/u.test(s)) return true;
  const m = DOUBLE_EXT.exec(s.replace(/[\s.]+$/u, ''));
  return !!m && DECOY_EXT.has(m[1].toLowerCase()) && EXEC_EXT.has(m[2].toLowerCase());
}

// ---- type ---------------------------------------------------------------------------------------------------------

const latin1 = (buf, start, end) => (start >= 0 && end <= buf.length && start < end ? buf.toString('latin1', start, end) : '');
const at = (buf, off, sig) => latin1(buf, off, off + sig.length) === sig;
const u16 = (buf, o) => (o >= 0 && o + 2 <= buf.length ? buf.readUInt16LE(o) : 0);
const u32 = (buf, o) => (o >= 0 && o + 4 <= buf.length ? buf.readUInt32LE(o) : 0);
const u64 = (buf, o) => (o >= 0 && o + 8 <= buf.length ? Number(buf.readBigUInt64LE(o)) : 0);

const OLE_MAGIC = '\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1';
const LNK_MAGIC = 'L\0\0\0\x01\x14\x02\0\0\0\0\0\xc0\0\0\0\0\0\0F';

export function detectType(buf, ext = '') {
  const n = buf.length;
  if (n === 0) return 'other';
  if (latin1(buf, 0, Math.min(n, 1024)).includes('%PDF-')) return 'pdf';
  if (at(buf, 0, 'PK\x03\x04') || at(buf, 0, 'PK\x05\x06')) return 'zip';
  if (at(buf, 0, OLE_MAGIC)) return 'ole';
  if (at(buf, 0, 'Rar!\x1a\x07')) return 'rar';
  if (at(buf, 0, '7z\xbc\xaf\x27\x1c')) return '7z';
  if (at(buf, 0, '\x1f\x8b')) return 'gzip';
  if (at(buf, 0, 'MZ')) return 'pe';
  if (at(buf, 0, '\x7fELF')) return 'elf';
  if (['\xfe\xed\xfa\xce', '\xfe\xed\xfa\xcf', '\xce\xfa\xed\xfe', '\xcf\xfa\xed\xfe'].some((m) => at(buf, 0, m))) return 'macho';
  // 0xCAFEBABE is also a Java class; a universal binary has a small architecture count where a class has its version
  if (at(buf, 0, '\xca\xfe\xba\xbe') && n >= 8 && buf.readUInt32BE(4) > 0 && buf.readUInt32BE(4) < 30) return 'macho';
  if (at(buf, 0, LNK_MAGIC)) return 'lnk';
  if (diskImageKind(buf)) return 'iso';
  if (at(buf, 0, '\x89PNG') || at(buf, 0, '\xff\xd8\xff') || at(buf, 0, 'GIF8') || at(buf, 0, 'BM') ||
    (at(buf, 0, 'RIFF') && at(buf, 8, 'WEBP')) || at(buf, 0, '\0\0\x01\0')) return 'image';
  if (!looksText(buf)) return 'other';
  if (SCRIPT_EXT.has(ext)) return 'script';
  const head = decodeText(buf, 64 * 1024).trimStart();
  if (head.startsWith('#!')) return 'script';
  if (head.startsWith('{\\rt')) return 'text';
  const lower = head.toLowerCase();
  const svgAt = lower.search(/<svg[\s>]/);
  const htmlAt = lower.search(/<!doctype\s+html|<html[\s>]/);
  if (svgAt >= 0 && (htmlAt < 0 || svgAt < htmlAt)) return 'svg';
  if (htmlAt >= 0 || /<(?:head|body|script|form|meta|iframe|title)[\s>]/.test(lower)) return 'html';
  return 'text';
}

function diskImageKind(buf) {
  for (const off of [0x8001, 0x8801, 0x9001]) {
    const s = latin1(buf, off, off + 5);
    if (s === 'CD001') return 'iso9660';
    if (s === 'BEA01' || s === 'NSR02' || s === 'NSR03') return 'udf';
  }
  const n = buf.length;
  if (at(buf, 0, 'conectix') || (n >= 512 && at(buf, n - 512, 'conectix'))) return 'vhd';
  if (at(buf, 0, 'vhdxfile')) return 'vhdx';
  if (n >= 512 && at(buf, n - 512, 'koly')) return 'dmg';
  return '';
}

const hasBom16 = (buf) => (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);

function looksText(buf) {
  if (buf.length >= 2 && hasBom16(buf)) return true;
  const n = Math.min(buf.length, 8192);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) bad += 1;
  }
  return bad <= n * 0.02;
}

function decodeText(buf, max) {
  const b = buf.subarray(0, max);
  if (b.length >= 2 && hasBom16(b)) {
    const body = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1)));
    if (b[0] === 0xfe) body.swap16();
    return body.toString('utf16le');
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('utf8');
}

function textOf(buf, ctx) {
  if (buf.length > FILE_LIMITS.textBytes) ctx.truncated = true;
  return decodeText(buf, FILE_LIMITS.textBytes);
}

// ---- inflate ------------------------------------------------------------------------------------------------------

/**
 * Inflates under the entry and the total budget. Truncated input yields what it holds (sync flush); output that does
 * not fit is a cap hit, charged in full so that many small bombs cannot add up.
 */
function inflateBounded(fn, input, ctx, cap = FILE_LIMITS.entryInflateBytes) {
  const room = Math.min(cap, FILE_LIMITS.totalInflateBytes - ctx.inflated);
  if (room <= 0) {
    ctx.truncated = true;
    return null;
  }
  try {
    const out = fn(input, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH });
    ctx.inflated += out.length;
    return out;
  } catch (err) {
    if (err instanceof RangeError) {
      ctx.inflated += room;
      ctx.truncated = true;
    }
    return null;
  }
}

// ---- zip ----------------------------------------------------------------------------------------------------------

const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1');

function zipName(raw, flags) {
  return raw.toString(flags & 0x800 ? 'utf8' : 'latin1');
}

/** Entries from the central directory, or, when it is missing or broken, from the local headers. */
function zipList(buf, ctx) {
  const list = [];
  let claimed = 0;
  const n = buf.length;
  let eocd = -1;
  for (let p = n - 22; p >= Math.max(0, n - 22 - 65535); p--) {
    if (buf[p] === 0x50 && u32(buf, p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd >= 0) {
    claimed = u16(buf, eocd + 10);
    const cdSize = u32(buf, eocd + 12);
    let cdOff = u32(buf, eocd + 16);
    if ((cdOff === 0xffffffff || claimed === 0xffff) && u32(buf, eocd - 20) === 0x07064b50) {
      const z = u64(buf, eocd - 12);
      if (u32(buf, z) === 0x06064b50) {
        claimed = u64(buf, z + 32);
        cdOff = u64(buf, z + 48);
      }
    }
    // a stub in front of the archive (self-extractor) moves every offset by its length
    let shift = 0;
    if (u32(buf, cdOff) !== ZIP_CENTRAL && u32(buf, eocd - cdSize) === ZIP_CENTRAL) shift = eocd - cdSize - cdOff;
    let p = cdOff + shift;
    while (u32(buf, p) === ZIP_CENTRAL && p + 46 <= n) {
      if (list.length >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; break; }
      const flags = u16(buf, p + 8);
      const nameLen = u16(buf, p + 28);
      list.push({
        flags,
        method: u16(buf, p + 10),
        csize: u32(buf, p + 20),
        usize: u32(buf, p + 24),
        local: u32(buf, p + 42) + shift,
        name: zipName(buf.subarray(p + 46, Math.min(n, p + 46 + nameLen)), flags),
      });
      p += 46 + nameLen + u16(buf, p + 30) + u16(buf, p + 32);
    }
  }
  if (list.length === 0) {
    let p = buf.indexOf(ZIP_LOCAL);
    while (p >= 0 && p + 30 <= n) {
      if (list.length >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; break; }
      const flags = u16(buf, p + 6);
      const nameLen = u16(buf, p + 26);
      const dataStart = p + 30 + nameLen + u16(buf, p + 28);
      const csize = u32(buf, p + 18);
      // with a data descriptor (bit 3) the sizes come after the data: the data runs to the next header
      const next = buf.indexOf(ZIP_LOCAL, flags & 8 ? dataStart : Math.max(p + 4, Math.min(n, dataStart + csize)));
      list.push({
        flags,
        method: u16(buf, p + 8),
        csize: flags & 8 ? (next < 0 ? n : next) - dataStart : csize,
        usize: flags & 8 ? 0 : u32(buf, p + 22),
        dataStart,
        name: zipName(buf.subarray(p + 30, Math.min(n, p + 30 + nameLen)), flags),
      });
      if (next <= p) break;
      p = next;
    }
  }
  return { list, claimed };
}

function readZipEntry(buf, e, ctx) {
  if (e.flags & 1) return null;
  if (ctx.parts >= FILE_LIMITS.partsRead) {
    ctx.truncated = true;
    return null;
  }
  ctx.parts += 1;
  let start = e.dataStart;
  if (start == null) {
    if (u32(buf, e.local) !== 0x04034b50) return null;
    start = e.local + 30 + u16(buf, e.local + 26) + u16(buf, e.local + 28);
  }
  if (start >= buf.length) return null;
  if (e.usize > FILE_LIMITS.entryInflateBytes) {
    ctx.truncated = true;
    return null;
  }
  const input = buf.subarray(start, Math.min(buf.length, start + e.csize));
  if (e.method === 0) {
    const room = Math.min(FILE_LIMITS.entryInflateBytes, FILE_LIMITS.totalInflateBytes - ctx.inflated);
    if (input.length > room) ctx.truncated = true;
    const out = input.subarray(0, Math.max(0, room));
    ctx.inflated += out.length;
    return out;
  }
  if (e.method === 8) return inflateBounded(inflateRawSync, input, ctx);
  return null;
}

function archiveEntry(ctx, name, { dir = false, encrypted = false } = {}) {
  ctx.entry(name);
  if (encrypted) ctx.add('archive_encrypted', name);
  if (dir) return;
  const ext = extOf(name);
  if (EXEC_EXT.has(ext)) ctx.add('archive_executable', name);
  if (ARCHIVE_EXT.has(ext)) ctx.add('nested_archive', name);
}

function analyzeZip(buf, ctx) {
  const { list, claimed } = zipList(buf, ctx);
  const byName = new Map(list.map((e) => [e.name.toLowerCase(), e]));
  if (byName.has('[content_types].xml')) ctx.type = 'ooxml';
  else if (byName.has('mimetype')) {
    const v = readZipEntry(buf, byName.get('mimetype'), ctx);
    if (v && latin1(v, 0, Math.min(v.length, 64)).startsWith('application/vnd.oasis.opendocument')) ctx.type = 'odf';
  }
  if (ctx.type === 'ooxml') return ooxmlParts(buf, list, ctx);
  if (ctx.type === 'odf') return odfParts(buf, list, ctx);
  ctx.entries = [];
  for (const e of list) archiveEntry(ctx, e.name, { dir: e.name.endsWith('/'), encrypted: (e.flags & 1) === 1 });
  if (claimed > ctx.entriesTotal && list.length >= FILE_LIMITS.archiveEntries) ctx.entriesTotal = claimed;
}

const DDE_PART = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|glossary\/document)\.xml$/;
const REMOTE_REL = words('attachedtemplate oleobject frame subdocument');

function ooxmlParts(buf, list, ctx) {
  for (const e of list) {
    const lower = e.name.toLowerCase();
    if (/(?:^|\/)vbaproject\.bin$/.test(lower)) {
      ctx.add('macros', e.name);
      guard(ctx, () => {
        const d = readZipEntry(buf, e, ctx);
        if (d) scanAutoExec(d, ctx);
      });
    } else if (lower.startsWith('xl/macrosheets/')) {
      ctx.add('macros', e.name);
    }
    if (/(?:^|\/)embeddings\/[^/]*\.bin$/.test(lower) || /(?:^|\/)oleobject\d*\.bin$/.test(lower)) ctx.add('ole_object', e.name);
    if (lower.endsWith('.rels')) {
      guard(ctx, () => {
        const d = readZipEntry(buf, e, ctx);
        if (d) relsFindings(d.toString('utf8'), ctx);
      });
    } else if (DDE_PART.test(lower)) {
      guard(ctx, () => {
        const d = readZipEntry(buf, e, ctx);
        if (d) fieldFindings(d.toString('utf8'), ctx);
      });
    } else if (/^xl\/externallinks\/[^/]*\.xml$/.test(lower)) {
      guard(ctx, () => {
        const d = readZipEntry(buf, e, ctx);
        if (d && /<(?:\w+:)?ddeLink\b/.test(d.toString('utf8'))) ctx.add('dde', 'ddeLink');
      });
    }
  }
}

function relsFindings(xml, ctx) {
  const re = /<(?:\w+:)?Relationship\b([^>]{0,4096})>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = parseAttrs(m[1]);
    const tail = (a.get('type') ?? '').split('/').pop().toLowerCase();
    const target = a.get('target') ?? '';
    if (/^\s*external\s*$/i.test(a.get('targetmode') ?? '')) {
      ctx.link(target);
      if (REMOTE_REL.has(tail)) ctx.add('external_template', hostOf(target) || target);
    } else if (tail === 'oleobject') {
      ctx.add('ole_object', target);
    }
  }
}

/** Field codes of a Word part: DDE fields and the addresses of HYPERLINK fields. Codes may be split across runs. */
function fieldFindings(xml, ctx) {
  const codes = [];
  const instr = /<w:instrText\b[^>]{0,200}>([^<]{0,4096})/g;
  const simple = /\bw:instr\s*=\s*"([^"]{0,4096})"/g;
  let m;
  while ((m = instr.exec(xml))) codes.push(decodeEntities(m[1]));
  while ((m = simple.exec(xml))) codes.push(' ' + decodeEntities(m[1]));
  const joined = codes.join('');
  const dde = /(?:^|[^A-Za-z])(DDE(?:AUTO)?)(?![A-Za-z])/i.exec(joined);
  if (dde) ctx.add('dde', joined.slice(dde.index).trim());
  plainUrls(codes.join(' '), ctx);
}

function odfParts(buf, list, ctx) {
  for (const e of list) {
    const lower = e.name.toLowerCase();
    if (/^(?:basic|scripts)\/./.test(lower)) ctx.add('macros', e.name);
    if (lower === 'content.xml' || lower === 'styles.xml') {
      guard(ctx, () => {
        const d = readZipEntry(buf, e, ctx);
        if (!d) return;
        const xml = d.toString('utf8');
        const re = /xlink:href\s*=\s*"([^"]{1,4096})"/g;
        let m;
        while ((m = re.exec(xml))) if (!ctx.link(decodeEntities(m[1]))) break;
        const ev = /script:event-name\s*=\s*"((?:office|dom):(?:load|new))"/i.exec(xml);
        if (ev) ctx.add('auto_exec', ev[1]);
      });
    }
  }
}

// ---- macros (OLE and VBA) -----------------------------------------------------------------------------------------

const AUTO_EXEC = /(?:^|[^A-Za-z0-9_])(Auto_?Open|AutoExec|AutoNew|Auto_?Close|Document_(?:Open|New|Close)|Workbook_(?:Open|Activate|BeforeClose))(?![A-Za-z0-9_])/i;
const OVBA_MARK = Buffer.from('\0Attribut', 'latin1');

/** Auto-run procedure names in a macro container: in plain text (p-code tables) or in the compressed VBA source. */
function scanAutoExec(buf, ctx) {
  const raw = AUTO_EXEC.exec(buf.toString('latin1'));
  if (raw) return ctx.add('auto_exec', raw[1]);
  // A compressed module source starts with 0x01, a chunk header and a flag byte of 0 before "Attribute VB_Name".
  let p = 0;
  for (let tries = 0; tries < FILE_LIMITS.ovbaContainers; tries++) {
    const k = buf.indexOf(OVBA_MARK, p);
    if (k < 0) return;
    p = k + 1;
    const start = k - 3;
    if (start < 0 || buf[start] !== 1) continue;
    const room = Math.min(FILE_LIMITS.ovbaOutBytes, FILE_LIMITS.ovbaTotalBytes - ctx.ovbaOut);
    if (room <= 0) break;
    const src = ovbaDecompress(buf, start, room);
    ctx.ovbaOut += src.length;
    const m = AUTO_EXEC.exec(src);
    if (m) return ctx.add('auto_exec', m[1]);
  }
  ctx.truncated = true;
}

/** MS-OVBA 2.4.1 decompression; stops quietly at the first malformed chunk. */
export function ovbaDecompress(buf, start, maxOut = FILE_LIMITS.ovbaOutBytes) {
  if (buf[start] !== 1) return '';
  const out = Buffer.alloc(Math.min(maxOut, (buf.length - start) * 8 + 4096));
  let o = 0;
  let p = start + 1;
  while (p + 2 <= buf.length && o < out.length) {
    const header = u16(buf, p);
    if (((header >> 12) & 7) !== 3) break;
    const chunkEnd = Math.min(buf.length, p + (header & 0x0fff) + 3);
    p += 2;
    const chunkStart = o;
    if (!(header & 0x8000)) {
      const n = Math.min(4096, buf.length - p, out.length - o);
      buf.copy(out, o, p, p + n);
      o += n;
      p += 4096;
      continue;
    }
    while (p < chunkEnd && o < out.length) {
      const flags = buf[p++];
      for (let bit = 0; bit < 8 && p < chunkEnd && o < out.length; bit++) {
        if (!((flags >> bit) & 1)) {
          out[o++] = buf[p++];
          continue;
        }
        if (p + 2 > chunkEnd) return out.toString('latin1', 0, o);
        const token = u16(buf, p);
        p += 2;
        let bits = 4;
        while ((1 << bits) < o - chunkStart && bits < 12) bits += 1;
        const length = (token & (0xffff >> bits)) + 3;
        const offset = (token >> (16 - bits)) + 1;
        if (offset > o - chunkStart) return out.toString('latin1', 0, o);
        for (let i = 0; i < length && o < out.length; i++, o++) out[o] = out[o - offset];
      }
    }
  }
  return out.toString('latin1', 0, o);
}

const utf16 = (s) => Buffer.from(s, 'utf16le');
const VBA_DIR = utf16('VBA\0');

function analyzeOle(buf, ctx) {
  let macros = buf.includes(utf16('_VBA_PROJECT'));
  if (macros) ctx.add('macros', '_VBA_PROJECT');
  else {
    // a directory entry (128 bytes, sector-aligned) named "VBA": name length 8 bytes including the terminator
    for (let p = buf.indexOf(VBA_DIR); p >= 0; p = buf.indexOf(VBA_DIR, p + 2)) {
      if (p % 128 === 0 && u16(buf, p + 64) === 8) {
        ctx.add('macros', 'VBA');
        macros = true;
        break;
      }
    }
  }
  if (macros) guard(ctx, () => scanAutoExec(buf, ctx));
  if (buf.includes(utf16('ObjectPool'))) ctx.add('ole_object', 'ObjectPool');
  else if (buf.includes(utf16('\u0001Ole10Native'))) ctx.add('ole_object', 'Ole10Native');
}

// ---- pdf ----------------------------------------------------------------------------------------------------------

const PDF_KEYS = new Map([
  ['JavaScript', 'pdf_javascript'],
  ['JS', 'pdf_javascript'],
  ['OpenAction', 'pdf_open_action'],
  ['AA', 'pdf_open_action'],
  ['Launch', 'pdf_launch'],
  ['EmbeddedFile', 'pdf_embedded_file'],
  ['EmbeddedFiles', 'pdf_embedded_file'],
  ['SubmitForm', 'pdf_submit_form'],
  ['Encrypt', 'pdf_encrypted'],
]);

const decodePdfName = (s) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function analyzePdf(buf, ctx) {
  const s = buf.toString('latin1');
  scanPdfText(s, ctx, '');
  let p = 0;
  for (let streams = 0; ; streams++) {
    if (streams >= FILE_LIMITS.pdfStreams) { ctx.truncated = true; return; }
    const k = s.indexOf('stream', p);
    if (k < 0) return;
    p = k + 6;
    if (k >= 3 && s.startsWith('end', k - 3)) continue;
    let d = k + 6;
    if (s[d] === '\r') d += 1;
    if (s[d] === '\n') d += 1;
    if (d === k + 6) continue;
    const e = s.indexOf('endstream', d);
    let end = e < 0 ? s.length : e;
    p = end;
    const before = s.slice(Math.max(0, k - 2048), k);
    const dict = decodePdfName(before.slice(Math.max(0, before.lastIndexOf('obj'))));
    if (!dict.includes('/FlateDecode')) continue;
    if (s[end - 1] === '\n') end -= 1;
    if (s[end - 1] === '\r') end -= 1;
    const out = inflateBounded(inflateSync, buf.subarray(d, Math.max(d, end)), ctx);
    if (out) scanPdfText(out.toString('latin1'), ctx, 'compressed');
  }
}

function scanPdfText(s, ctx, where) {
  const re = /\/([^\s/<>[\](){}%]{1,127})/g;
  let m;
  while ((m = re.exec(s))) {
    if (++ctx.pdfNames > FILE_LIMITS.pdfNames) { ctx.truncated = true; return; }
    const name = m[1].includes('#') ? decodePdfName(m[1]) : m[1];
    const id = PDF_KEYS.get(name);
    if (id) ctx.add(id, where);
    else if (name === 'URI') {
      // every unterminated "(" would read a full string: the reading has a budget of its own
      if (ctx.links.length >= FILE_LIMITS.links || ctx.pdfStringRead > FILE_LIMITS.pdfStringBudget) ctx.truncated = true;
      else ctx.link(pdfStringAt(s, re.lastIndex, ctx));
    }
  }
}

const PDF_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** The string value at `i` (literal or hex), decoded; '' when there is none. */
function pdfStringAt(s, i, ctx) {
  const max = FILE_LIMITS.pdfStringChars;
  const from = i;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  let out = '';
  if (s[i] === '(') {
    let depth = 1;
    i += 1;
    while (i < s.length && out.length < max) {
      const ch = s[i++];
      if (ch === '\\') {
        const nx = s[i++] ?? '';
        if (/[0-7]/.test(nx)) {
          let oct = nx;
          while (oct.length < 3 && /[0-7]/.test(s[i] ?? '')) oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (nx === '\r' || nx === '\n') {
          if (nx === '\r' && s[i] === '\n') i += 1;
        } else out += PDF_ESCAPES[nx] ?? nx;
      } else if (ch === '(') {
        depth += 1;
        out += ch;
      } else if (ch === ')') {
        if (--depth === 0) break;
        out += ch;
      } else out += ch;
    }
  } else if (s[i] === '<' && s[i + 1] !== '<') {
    const win = s.slice(i + 1, i + 1 + 2 * max);
    const e = win.indexOf('>');
    const hex = (e < 0 ? win : win.slice(0, e)).replace(/[^0-9a-fA-F]/g, '');
    for (let j = 0; j + 1 < hex.length; j += 2) out += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
    i += 1 + (e < 0 ? win.length : e);
  }
  ctx.pdfStringRead += i - from;
  if (out.startsWith('\xfe\xff')) {
    const b = Buffer.from(out.slice(2, 2 + ((out.length - 2) & ~1)), 'latin1');
    out = b.swap16().toString('utf16le');
  }
  return out;
}

// ---- html and svg -------------------------------------------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', sol: '/', period: '.', lpar: '(', rpar: ')' };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});?/g, (whole, e) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Attributes of one tag body; names lowercased, values entity-decoded. The body is already cut to tagChars. */
function parseAttrs(body) {
  const attrs = new Map();
  const re = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

const LINK_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster'];

/**
 * One linear pass over the tags: every '<' is looked at once and the scan jumps past the tag's '>', so no pattern
 * ever runs from many starts to the end of the file.
 */
function analyzeHtml(text, ctx, { svg = false } = {}) {
  const forms = [];
  let open = null;
  let title = '';
  const scripts = [];
  let scriptChars = 0;
  const pushScript = (code) => {
    if (scriptChars >= FILE_LIMITS.scriptChars) { ctx.truncated = true; return; }
    const part = code.slice(0, FILE_LIMITS.scriptChars - scriptChars);
    scripts.push(part);
    scriptChars += part.length + 1;
  };
  let i = 0;
  for (let tags = 0; ; tags++) {
    if (tags >= FILE_LIMITS.htmlTags) { ctx.truncated = true; break; }
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    let gt = text.indexOf('>', lt + 1);
    if (gt < 0) gt = text.length;
    i = gt + 1;
    const body = text.slice(lt + 1, Math.min(gt, lt + 1 + FILE_LIMITS.tagChars));
    const m = /^(\/?)([a-zA-Z][\w:-]{0,40})/.exec(body);
    if (!m) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (tag === 'form') open = null;
      continue;
    }
    const attrs = parseAttrs(body.slice(m[0].length));
    for (const k of LINK_ATTRS) if (attrs.has(k)) ctx.link(attrs.get(k));
    for (const [k, v] of attrs) {
      if (!k.startsWith('on') || k.length < 4) continue;
      if (svg) ctx.add('svg_script', k);
      pushScript(v);
    }
    if (svg && /^\s*javascript:/i.test(attrs.get('href') ?? attrs.get('xlink:href') ?? '')) ctx.add('svg_script', 'javascript: link');
    if (tag === 'title' && !title) {
      const e = text.indexOf('<', i);
      title = cut(oneLine(decodeEntities(text.slice(i, e < 0 ? i + 2000 : Math.min(e, i + 2000)))).replace(/\s+/g, ' '), FILE_LIMITS.titleChars);
    } else if (tag === 'form') {
      const action = (attrs.get('action') ?? '').trim();
      open = { action: cut(action, FILE_LIMITS.urlChars), password: false };
      if (forms.length < FILE_LIMITS.forms) forms.push(open);
      else ctx.truncated = true;
      if (/^https?:\/\//i.test(action)) ctx.add('html_form_elsewhere', hostOf(action));
    } else if (tag === 'input') {
      if ((attrs.get('type') ?? '').trim().toLowerCase() === 'password') {
        ctx.add('html_password_form', open ? open.action : 'outside a form');
        if (open) open.password = true;
      }
    } else if (tag === 'meta') {
      if (/refresh/i.test(attrs.get('http-equiv') ?? '')) {
        const u = /url\s*=\s*['"]?\s*([^'"\s>]+)/i.exec(attrs.get('content') ?? '');
        if (u && /^https?:\/\//i.test(u[1])) {
          ctx.add('html_redirect', hostOf(u[1]));
          ctx.link(u[1]);
        }
      }
    } else if (tag === 'script') {
      if (svg) ctx.add('svg_script', 'script');
      const close = /<\/script/gi;
      close.lastIndex = i;
      const e = close.exec(text);
      const stop = e ? e.index : text.length;
      pushScript(text.slice(i, stop));
      i = stop;
    }
  }
  guard(ctx, () => analyzeScript(scripts.join('\n'), ctx));
  ctx.html = { title, forms };
}

const DECODER = /\b(atob|unescape|decodeURIComponent|fromCharCode|eval|document\.write|Function)\s*\(/;
const ENCODED_RUN = /(?:%[0-9a-fA-F]{2}){50,}|(?:\\x[0-9a-fA-F]{2}){50,}|(?:\\u[0-9a-fA-F]{4}){50,}/;
const CHAR_CODES = /fromCharCode\s*\(\s*(?:\d{1,6}\s*,\s*){30,}/;

/** A run of at least `min` base64 characters, counted by hand: a pattern would rescan every short run. */
function hasBase64Run(s, min = 200) {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const b64 = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47;
    run = b64 ? run + 1 : 0;
    if (run >= min) return true;
  }
  return false;
}

function analyzeScript(s, ctx) {
  if (!s) return;
  const dec = DECODER.exec(s);
  if ((dec && (hasBase64Run(s) || ENCODED_RUN.test(s))) || CHAR_CODES.test(s)) ctx.add('html_obfuscated_script', dec ? dec[1] : 'fromCharCode');
  const redirect = /\blocation(?:\.href)?\s*=\s*["'`](https?:\/\/[^"'`\s]{1,2048})|\blocation\.(?:replace|assign)\s*\(\s*["'`](https?:\/\/[^"'`\s]{1,2048})/gi;
  let m;
  for (let n = 0; n < 50 && (m = redirect.exec(s)); n++) {
    const target = m[1] ?? m[2];
    ctx.add('html_redirect', hostOf(target));
    ctx.link(target);
  }
  if (/\bBlob\s*\(/.test(s) && /\bcreateObjectURL\s*\(/.test(s) &&
    /\.download\s*=|\bmsSaveOrOpenBlob\b|\bmsSaveBlob\b|setAttribute\s*\(\s*["']download["']/.test(s)) ctx.add('html_smuggling', '');
  plainUrls(s, ctx);
}

// ---- other archives -----------------------------------------------------------------------------------------------

function vint(buf, p) {
  if (p < 0) return [0, -1];
  let v = 0;
  for (let i = 0; i < 10 && p + i < buf.length; i++) {
    const b = buf[p + i];
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return [v, p + i + 1];
  }
  return [0, -1];
}

function analyzeRar(buf, ctx) {
  ctx.entries = [];
  if (at(buf, 0, 'Rar!\x1a\x07\x01\x00')) return rar5(buf, ctx);
  let p = 7;
  for (let n = 0; p + 7 <= buf.length; n++) {
    if (n >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; return; }
    const type = buf[p + 2];
    const flags = u16(buf, p + 3);
    const size = u16(buf, p + 5);
    if (size < 7) return;
    if (type === 0x73 && flags & 0x80) {
      ctx.add('archive_encrypted', 'headers');
      return;
    }
    let add = flags & 0x8000 || type === 0x74 ? u32(buf, p + 7) : 0;
    if (type === 0x74) {
      let off = p + 32;
      if (flags & 0x100) {
        add += u32(buf, p + 32) * 2 ** 32;
        off += 8;
      }
      const raw = buf.subarray(off, Math.min(buf.length, off + u16(buf, p + 26)));
      const z = raw.indexOf(0);
      const name = (z >= 0 ? raw.subarray(0, z) : raw).toString(flags & 0x200 && z < 0 ? 'utf8' : 'latin1');
      archiveEntry(ctx, name, { dir: (flags & 0xe0) === 0xe0, encrypted: (flags & 0x04) !== 0 });
    }
    if (type === 0x7b) return;
    p += size + add;
  }
}

function rar5(buf, ctx) {
  let p = 8;
  for (let n = 0; p + 4 < buf.length; n++) {
    if (n >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; return; }
    let [size, q] = vint(buf, p + 4);
    if (q < 0 || size === 0) return;
    const end = q + size;
    let type, hflags, extra = 0, data = 0;
    [type, q] = vint(buf, q);
    [hflags, q] = vint(buf, q);
    if (q < 0) return;
    if (hflags & 1) [extra, q] = vint(buf, q);
    if (hflags & 2) [data, q] = vint(buf, q);
    if (q < 0) return;
    if (type === 4) {
      ctx.add('archive_encrypted', 'headers');
      return;
    }
    if (type === 2) {
      let fflags, nameLen;
      [fflags, q] = vint(buf, q);
      [, q] = vint(buf, q); // unpacked size
      [, q] = vint(buf, q); // attributes
      if (fflags & 2) q += 4;
      if (fflags & 4) q += 4;
      [, q] = vint(buf, q); // compression
      [, q] = vint(buf, q); // host os
      [nameLen, q] = vint(buf, q);
      if (q < 0) return;
      const name = buf.toString('utf8', q, Math.min(buf.length, q + nameLen, end));
      let encrypted = false;
      for (let e = end - extra, r = 0; e < end && r < 64; r++) {
        const [rsize, e1] = vint(buf, e);
        const [rtype] = vint(buf, e1);
        if (e1 < 0 || rsize === 0) break;
        if (rtype === 1) encrypted = true;
        e = e1 + rsize;
      }
      archiveEntry(ctx, name, { dir: (fflags & 1) === 1, encrypted });
    }
    if (type === 5) return;
    p = end + data;
  }
}

const AES_CODER = Buffer.from([0x06, 0xf1, 0x07, 0x01]);
function analyze7z(buf, ctx) {
  const start = 32 + u64(buf, 12);
  const size = Math.min(u64(buf, 20), MiB);
  if (start < buf.length && buf.subarray(start, Math.min(buf.length, start + size)).includes(AES_CODER)) ctx.add('archive_encrypted', 'headers');
}

/** The whole content, or, when it overflows the budget, what its first bytes inflate to. */
function inflateHead(fn, input, ctx) {
  const all = inflateBounded(fn, input, ctx);
  if (all) return all;
  return inflateBounded(fn, input.subarray(0, FILE_LIMITS.headInputBytes), ctx);
}

const isTar = (b) => b.length >= 512 && at(b, 257, 'ustar');
const cstr = (b, off, len) => {
  const s = b.subarray(off, Math.min(b.length, off + len));
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
};

function tarEntries(b, ctx) {
  ctx.entries ??= [];
  let p = 0;
  let longName = null;
  for (let n = 0; p + 512 <= b.length; n++) {
    if (n >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; return; }
    if (b[p] === 0) return;
    const name = cstr(b, p, 100);
    const prefix = at(b, p + 257, 'ustar') ? cstr(b, p + 345, 155) : '';
    const size = parseInt(cstr(b, p + 124, 12).trim(), 8) || 0;
    const type = b[p + 156];
    p += 512;
    if (type === 0x4c) longName = cstr(b, p, Math.min(size, 4096));
    else if (type !== 0x78 && type !== 0x67) {
      archiveEntry(ctx, longName ?? (prefix ? `${prefix}/${name}` : name), { dir: type === 0x35 });
      longName = null;
    }
    p += Math.ceil(size / 512) * 512;
  }
}

function analyzeGzip(buf, ctx) {
  const flg = buf[3];
  let p = 10;
  if (flg & 4) p += 2 + u16(buf, 10);
  let fname = '';
  if (flg & 8) {
    const z = buf.indexOf(0, p);
    fname = latin1(buf, p, Math.min(z < 0 ? buf.length : z, p + 1024));
  }
  const inner = inflateHead(gunzipSync, buf, ctx);
  if (inner && isTar(inner)) return tarEntries(inner, ctx);
  if (fname) {
    ctx.entries = [];
    archiveEntry(ctx, fname);
  }
  if (!inner) return;
  const t = detectType(inner, extOf(fname));
  if (ARCHIVE_TYPES.has(t)) ctx.add('nested_archive', fname || t);
  if (EXEC_TYPES.has(t)) ctx.add('archive_executable', fname || t);
}

function analyzeIso(buf, ctx) {
  const kind = diskImageKind(buf);
  ctx.add('disk_image', kind);
  if (kind !== 'iso9660') return;
  let pvd = -1;
  let joliet = -1;
  for (let s = 16; s < 64; s++) {
    const o = s * 2048;
    if (!at(buf, o + 1, 'CD001')) break;
    if (buf[o] === 1 && pvd < 0) pvd = o;
    if (buf[o] === 2 && /%\/[@CE]/.test(latin1(buf, o + 88, o + 120))) joliet = o;
    if (buf[o] === 255) break;
  }
  const vd = joliet >= 0 ? joliet : pvd;
  if (vd < 0) return;
  ctx.entries = [];
  const start = u32(buf, vd + 156 + 2) * 2048;
  const end = Math.min(buf.length, start + Math.min(u32(buf, vd + 156 + 10), MiB));
  for (let p = start, n = 0; p < end; n++) {
    if (n >= FILE_LIMITS.archiveEntries) { ctx.truncated = true; return; }
    const len = buf[p];
    if (!len) {
      p = start + (Math.floor((p - start) / 2048) + 1) * 2048;
      continue;
    }
    const nameLen = buf[p + 32] ?? 0;
    const raw = buf.subarray(p + 33, Math.min(end, p + 33 + nameLen));
    const self = nameLen === 1 && (raw[0] === 0 || raw[0] === 1);
    if (!self && raw.length) {
      let name = joliet >= 0 ? Buffer.from(raw.subarray(0, raw.length & ~1)).swap16().toString('utf16le') : raw.toString('latin1');
      name = name.replace(/;\d+$/, '');
      archiveEntry(ctx, name, { dir: (buf[p + 25] & 2) === 2 });
    }
    p += len;
  }
}

// ---- executables and shortcuts ------------------------------------------------------------------------------------

function analyzePe(buf, ctx) {
  const pe = u32(buf, 0x3c);
  if (!at(buf, pe, 'PE\0\0')) return ctx.add('executable', 'DOS executable');
  const kind = u16(buf, pe + 24) === 0x20b ? 'PE32+' : 'PE32';
  ctx.add('executable', `${kind} ${u16(buf, pe + 22) & 0x2000 ? 'DLL' : 'executable'}`);
}

function analyzeLnk(buf, ctx) {
  let command = '';
  guard(ctx, () => { command = lnkCommand(buf, ctx); });
  ctx.add('shortcut', command);
}

/** What the shortcut runs: its target (or relative path) and arguments; addresses in them are links. */
function lnkCommand(buf, ctx) {
  const flags = u32(buf, 0x14);
  let p = 0x4c;
  if (flags & 0x01) p += 2 + u16(buf, p);
  let target = '';
  if (flags & 0x02) {
    const size = u32(buf, p);
    if (u32(buf, p + 8) & 1) target = cstr(buf, p + u32(buf, p + 16), 260);
    p += Math.max(size, 4);
  }
  const unicode = (flags & 0x80) !== 0;
  const read = () => {
    const n = u16(buf, p);
    const bytes = unicode ? n * 2 : n;
    const s = buf.toString(unicode ? 'utf16le' : 'latin1', Math.min(buf.length, p + 2), Math.min(buf.length, p + 2 + bytes));
    p += 2 + bytes;
    return s;
  };
  const strings = {};
  for (const [bit, key] of [[0x04, 'name'], [0x08, 'rel'], [0x10, 'dir'], [0x20, 'args'], [0x40, 'icon']]) if (flags & bit) strings[key] = read();
  plainUrls(`${strings.args ?? ''} ${strings.icon ?? ''}`, ctx);
  return [target || strings.rel || '', strings.args || ''].filter(Boolean).join(' ');
}

const ANALYZERS = {
  pdf: analyzePdf,
  zip: analyzeZip,
  ole: analyzeOle,
  rar: analyzeRar,
  '7z': analyze7z,
  gzip: analyzeGzip,
  iso: analyzeIso,
  pe: analyzePe,
  elf: (buf, ctx) => ctx.add('executable', buf[4] === 2 ? 'ELF 64-bit' : 'ELF 32-bit'),
  macho: (buf, ctx) => ctx.add('executable', 'Mach-O'),
  lnk: analyzeLnk,
  html: (buf, ctx) => analyzeHtml(textOf(buf, ctx), ctx),
  svg: (buf, ctx) => analyzeHtml(textOf(buf, ctx), ctx, { svg: true }),
  script: (buf, ctx, ext) => {
    ctx.add('script_file', ext || 'shebang');
    const text = textOf(buf, ctx);
    if (ext === 'hta') analyzeHtml(text, ctx);
    plainUrls(text, ctx);
  },
  text: (buf, ctx) => {
    const text = textOf(buf, ctx);
    if (text.startsWith('{\\rt') && /\\obj(?:data|emb|link|autlink|update|ocx)\b/.test(text)) ctx.add('ole_object', 'rtf');
    plainUrls(text, ctx);
  },
  other: (buf, ctx) => {
    if (isTar(buf)) tarEntries(buf, ctx);
  },
};
