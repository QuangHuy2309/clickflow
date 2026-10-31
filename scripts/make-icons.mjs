// Renders the extension icons and the store promo tile as PNGs with no
// dependencies (supersampled vector shapes + zlib). Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// alpha: false writes 24-bit RGB (the Web Store requires it for promo
// images); the pixels must already be opaque.
function png(width, height, rgba, { alpha = true } = {}) {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * bpp + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < bpp; c++) raw[row + 1 + x * bpp + c] = rgba[(y * width + x) * 4 + c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));
const INDIGO = [99, 102, 241];
const VIOLET = [139, 92, 246];
const WHITE = [255, 255, 255];
const DOT_COLORS = [[94, 234, 212], [253, 186, 116], [244, 114, 182]];

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Cursor arrow, in unit coordinates of the icon square.
const CURSOR = [[0.34, 0.24], [0.34, 0.76], [0.46, 0.645], [0.555, 0.84], [0.635, 0.80], [0.54, 0.605], [0.71, 0.605]];
const DOTS = [[0.24, 0.24], [0.24, 0.40], [0.24, 0.56]];

// Returns [r,g,b,a] for a point in unit icon space, or null if transparent.
function iconSample(u, v) {
  if (!inRoundRect(u, v, 0.04, 0.04, 0.92, 0.92, 0.22)) return null;
  if (inPolygon(u, v, CURSOR)) return [...WHITE, 255];
  for (let i = 0; i < DOTS.length; i++) {
    const [dx, dy] = DOTS[i];
    if ((u - dx) ** 2 + (v - dy) ** 2 <= 0.045 ** 2) return [...DOT_COLORS[i], 255];
  }
  return [...mix(INDIGO, VIOLET, (u + v) / 2), 255];
}

function render(width, height, sample, ss = 4) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / width, (y + (sy + 0.5) / ss) / height, width, height);
          if (!c) continue;
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (y * width + x) * 4;
      if (a) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
      out[i + 3] = a / (ss * ss);
    }
  }
  return out;
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(root, 'icons', `icon${size}.png`), png(size, size, render(size, size, iconSample)));
}

// 440×280 promo tile: gradient background with the icon and a row of "step" chips.
mkdirSync(join(root, 'store'), { recursive: true });
const TW = 440, TH = 280;
const CHIP_COLORS = [[91, 91, 240], [14, 159, 157], [217, 119, 6], [139, 92, 246]];
writeFileSync(join(root, 'store', 'promo-small-440x280.png'), png(TW, TH, render(TW, TH, (u, v) => {
  const x = u * TW, y = v * TH;
  const bg = mix([30, 27, 75], [76, 29, 149], (u * 0.7 + v * 0.3));
  const iconBox = { x: 40, y: 76, s: 128 };
  if (x >= iconBox.x && x < iconBox.x + iconBox.s && y >= iconBox.y && y < iconBox.y + iconBox.s) {
    const c = iconSample((x - iconBox.x) / iconBox.s, (y - iconBox.y) / iconBox.s);
    // The icon's soft edges are blended into the background: no alpha.
    if (c) return [...mix(bg, c.slice(0, 3), (c[3] ?? 255) / 255), 255];
  }
  for (let i = 0; i < 4; i++) {
    const cy = 62 + i * 42;
    if (inRoundRect(x, y, 200, cy, 200, 30, 10)) {
      if (inRoundRect(x, y, 210, cy + 7, 16, 16, 5)) return [...CHIP_COLORS[i], 255];
      if (inRoundRect(x, y, 236, cy + 11, 110 - i * 14, 8, 4)) return [205, 208, 230, 255];
      return [255, 255, 255, 255];
    }
  }
  return [...bg, 255];
}, 2), { alpha: false }));

console.log('Icons written to icons/, promo tile to store/');
