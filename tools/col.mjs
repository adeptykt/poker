// Печатает цвета пикселей по колонке/строке — для разбора геометрии фишки.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; color = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') palette = Buffer.from(d);
    else if (type === 'tRNS') trns = Buffer.from(d);
    else if (type === 'IDAT') idat.push(Buffer.from(d));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('only 8-bit non-interlaced PNG');
  const ch = color === 6 ? 4 : color === 2 ? 3 : color === 3 ? 1 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) << 2;
      if (color === 6) { out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]; }
      else if (color === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
      else { const i = line[x] * 3; out[o] = palette[i]; out[o + 1] = palette[i + 1]; out[o + 2] = palette[i + 2]; out[o + 3] = trns && line[x] < trns.length ? trns[line[x]] : 255; }
    }
    prev = line;
  }
  return { w, h, data: out };
}

const file = process.argv[2];
const axis = process.argv[3];     // col | row
const at = +process.argv[4];      // x for col, y for row
const from = +process.argv[5];
const to = +process.argv[6];
const png = decodePNG(readFileSync(file));
const px = (x, y) => { const i = (png.w * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]; };

let lines = 0, prevKey = null;
for (let v = from; v <= to; v++) {
  const [r, g, b, a] = axis === 'col' ? px(at, v) : px(v, at);
  const hex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  const felt = g > r + 16 && g > b + 8 && g > 55;
  const key = hex + (felt ? 'F' : '');
  if (key === prevKey) continue;      // печатаем только смены цвета
  prevKey = key;
  console.log(`${axis === 'col' ? 'y' : 'x'}=${String(v).padStart(4)}  ${hex}  rgb(${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)})  a=${a}${felt ? '  сукно' : ''}`);
  lines++;
}
console.log(`\nсмен цвета: ${lines}`);
