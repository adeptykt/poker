// Измеряет габариты фишки: по строкам — левая/правая граница «не сукна».
// Автономный PNG-декодер (только 8-бит RGB/RGBA/палитра, без интерлейса).
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      depth = d[8]; color = d[9]; interlace = d[12];
    } else if (type === 'PLTE') palette = Buffer.from(d);
    else if (type === 'tRNS') trns = Buffer.from(d);
    else if (type === 'IDAT') idat.push(Buffer.from(d));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNG supported');
  if (interlace) throw new Error('interlaced PNG not supported');
  const ch = color === 6 ? 4 : color === 2 ? 3 : color === 3 ? 1 : color === 0 ? 1 : 0;
  if (!ch) throw new Error(`unsupported colour type ${color}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) << 2;
      if (color === 6) { out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]; }
      else if (color === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
      else if (color === 0) { out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255; }
      else { const i = line[x] * 3; out[o] = palette[i]; out[o + 1] = palette[i + 1]; out[o + 2] = palette[i + 2]; out[o + 3] = trns && line[x] < trns.length ? trns[line[x]] : 255; }
    }
    prev = line;
  }
  return { w, h, data: out };
}

const [file, sx, sy, sw, sh] = process.argv.slice(2);
const x0 = +sx, y0 = +sy, w = +sw, h = +sh;
const png = decodePNG(readFileSync(file));
const isFelt = (r, g, b) => g > r + 16 && g > b + 8 && g > 55;

let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
const rows = [];
for (let y = y0; y < y0 + h; y++) {
  let L = -1, R = -1, n = 0;
  for (let x = x0; x < x0 + w; x++) {
    const i = (png.w * y + x) << 2;
    if (png.data[i + 3] < 40) continue;
    if (isFelt(png.data[i], png.data[i + 1], png.data[i + 2])) continue;
    if (L < 0) L = x;
    R = x; n++;
  }
  rows.push({ y, L, R, span: L < 0 ? 0 : R - L + 1, n });
  if (n >= 3) {
    if (L < minX) minX = L;
    if (R > maxX) maxX = R;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
console.log(`${file}  окно x${x0}-${x0 + w - 1} y${y0}-${y0 + h - 1}`);
console.log('    y |    L |    R | span | count');
for (const r of rows) {
  console.log(`  ${String(r.y).padStart(4)}|${String(r.L).padStart(6)}|${String(r.R).padStart(6)}|${String(r.span).padStart(6)}|${String(r.n).padStart(6)}`);
}
console.log(`\nbbox  x${minX}-${maxX} (w=${maxX - minX + 1})  y${minY}-${maxY} (h=${maxY - minY + 1})`);
