// 앱 아이콘(PNG)을 만든다: 검은 바탕 위에 마커 줄 세 개.
// 실행: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1d, 0x1d, 0x1f];
const STROKES = [
  { color: [0xe5, 0x8a, 0x9a], y: 0.33, from: 0.24, to: 0.70 },
  { color: [0x6f, 0xbf, 0xae], y: 0.47, from: 0.24, to: 0.78 },
  { color: [0xf2, 0xb6, 0x5a], y: 0.61, from: 0.24, to: 0.60 },
];
const THICK = 0.085;
const SLANT = 0.45; // 마커 끝이 비스듬히 잘린 모양

function colorAt(u, v) {
  for (const s of STROKES) {
    const dy = v - s.y;
    if (Math.abs(dy) > THICK / 2) continue;
    const shift = dy * SLANT;
    if (u >= s.from + shift && u <= s.to + shift) return s.color;
  }
  return BG;
}

function png(size) {
  const AA = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < AA; sy++) {
        for (let sx = 0; sx < AA; sx++) {
          const c = colorAt((x + (sx + 0.5) / AA) / size, (y + (sy + 0.5) / AA) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r / (AA * AA); raw[o + 1] = g / (AA * AA); raw[o + 2] = b / (AA * AA);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), png(size));
}
console.log('icons/icon-192.png, icons/icon-512.png 만들었어요');
