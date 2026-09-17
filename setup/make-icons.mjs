#!/usr/bin/env node
/**
 * Generate the app icons as real PNGs using only node:zlib.
 * Committed output means the repo needs no image toolchain and no packages.
 * Run with: node setup/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'web', 'icons');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4 + 1);
    row[0] = 0;   // no filter
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      row[1 + x * 4] = r; row[2 + x * 4] = g; row[3 + x * 4] = b; row[4 + x * 4] = a;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A simple parcel mark: rounded dark tile, light box, blue tape band. */
function icon(x, y, size) {
  const u = size / 32;                      // design grid unit
  const cx = x / u;
  const cy = y / u;

  // Rounded-square background.
  const r = 7;
  const dx = Math.max(r - cx, cx - (32 - r), 0);
  const dy = Math.max(r - cy, cy - (32 - r), 0);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];

  const bg = [17, 22, 29, 255];
  const box = [232, 237, 244, 255];
  const lid = [200, 210, 223, 255];
  const tape = [77, 163, 255, 255];

  // Parcel body.
  const inBox = cx >= 7 && cx <= 25 && cy >= 11 && cy <= 25;
  const inLid = cx >= 7 && cx <= 25 && cy >= 7 && cy < 11;
  if (!inBox && !inLid) return bg;

  // Vertical tape band.
  if (cx >= 14.5 && cx <= 17.5) return tape;
  return inLid ? lid : box;
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png(size, icon));
  console.log(`wrote ${file}`);
}
