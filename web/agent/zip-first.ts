// The first file of a zip archive, read through its central directory. Enough for the one-file archives the Tranco list
// comes in (tools/fetch-tranco.mjs); not a general zip reader: no zip64, no encryption, no second file.

import { inflateRawSync } from 'node:zlib';

export function firstZipEntry(zip: Uint8Array, maxBytes: number): Buffer {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const cd = b.readUInt32LE(eocd + 16);
  if (b.readUInt32LE(eocd + 10) < 1 || cd + 46 > b.length || b.readUInt32LE(cd) !== 0x02014b50) throw new Error('no file in the archive');
  const method = b.readUInt16LE(cd + 10);
  const packed = b.readUInt32LE(cd + 20);
  const size = b.readUInt32LE(cd + 24);
  const local = b.readUInt32LE(cd + 42);
  if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('zip64 is not read');
  if (size > maxBytes) throw new Error('the file in the archive is too large');
  if (local + 30 > b.length || b.readUInt32LE(local) !== 0x04034b50) throw new Error('broken local header');
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  if (start + packed > b.length) throw new Error('the archive is cut short');
  const data = b.subarray(start, start + packed);
  const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: maxBytes }) : null;
  if (out === null) throw new Error(`zip method ${method} is not read`);
  if (out.length !== size) throw new Error('the file in the archive has the wrong size');
  return out;
}
