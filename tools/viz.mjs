#!/usr/bin/env node
/**
 * viz.mjs — zero-dependency visual inspection toolkit for pixel-accurate UI work.
 *
 * Solves the three problems that normally require three different tools:
 *   1. capture  — screenshot at an EXACT viewport size, even one smaller than the
 *                 OS window minimum (headless Chrome silently clamps --window-size).
 *   2. probe    — measure geometry in a screenshot with named, reusable colour
 *                 classifiers instead of one-off throwaway scripts.
 *   3. diff     — compare against a reference and localise the differences.
 *
 * Requires only Node >= 20 (for the global fetch/WebSocket used by CDP).
 * No npm install, no Python, no ImageMagick.
 *
 *   node tools/viz.mjs capture --url http://127.0.0.1:8770/ --w 376 --h 696 --out shot.png
 *   node tools/viz.mjs probe --file shot.png --rows 160,500 --mode edge --class felt
 *   node tools/viz.mjs probe --file shot.png --rows 668 --mode runs --class red,green,gold
 *   node tools/viz.mjs probe --file shot.png --y0 630 --y1 695 --mode band --class red
 *   node tools/viz.mjs probe --file shot.png --cols 40,190,330 --y0 646 --y1 692 --mode dump
 *   node tools/viz.mjs diff --a ref.png --b shot.png --heatmap d.png
 *   node tools/viz.mjs crop --file shot.png --crop 0,625,376,71 --scale 3 --out zoom.png
 *   node tools/viz.mjs classes
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

// ─────────────────────────────────────────────────────────────────────────────
// PNG codec — decode to RGBA, encode from RGBA. 8-bit, non-interlaced.
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Decode a PNG buffer into {w, h, data} where data is RGBA, 4 bytes/px. */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG file (bad signature)');
  }
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit)`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter type ${filter} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
  }

  // normalise to RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (colorType === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (colorType === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (colorType === 0) { r = g = b = out[i]; }
    else { // palette
      const idx = out[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { w, h, data: rgba };
}

/** Encode an RGBA buffer into a PNG. */
export function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function loadPNG(file) {
  const p = resolve(file);
  if (!existsSync(p)) throw new Error(`file not found: ${p}`);
  return decodePNG(readFileSync(p));
}

/** Read one pixel; returns [r,g,b]. */
export function px(img, x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifiers — the calibrated colour recipes.
//
// These thresholds were tuned empirically against real screenshots; they are the
// reusable part of the measurement work. Add your own to CLASSIFIERS.
// ─────────────────────────────────────────────────────────────────────────────

export const CLASSIFIERS = {
  // bright green felt/table surface
  felt: (r, g, b) => g > r + 16 && g > b + 8 && g > 55,
  // stricter felt test, rejects teal-ish chip colours
  feltStrict: (r, g, b) => g > r + 25 && g > b + 15 && g > 70,
  // neutral grey leather (rail), excludes dark backgrounds and bright highlights
  grey: (r, g, b) => Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 28 && r < 130,
  greyWide: (r, g, b) => Math.abs(r - g) < 10 && Math.abs(g - b) < 12 && r > 26 && r < 150,
  // red: fold button, hearts/diamonds suits.
  // g-b < 35 rejects gold/olive chrome (e.g. 191,133,71), which otherwise also
  // satisfies r > g+25 && r > b+25.
  red: (r, g, b) => r > 70 && r > g + 25 && r > b + 25 && g - b < 35,
  // green: call button, clubs/spades are NOT green (they are dark)
  green: (r, g, b) => g > 60 && g > r + 20 && g > b + 10,
  // gold/tan: raise button, window chrome, chip accents
  gold: (r, g, b) => r > 90 && g > 70 && r > b + 40 && g > b + 30,
  white: (r, g, b) => r > 230 && g > 230 && b > 230,
  // blue card back (face-down hole card): blue dominates both other channels
  blue: (r, g, b) => b > r + 25 && b > g + 12 && b > 120,
  // paper: bright, slightly cool card stock / white border of a card back
  paper: (r, g, b) => r > 190 && g > 195 && b > 200 && b >= r,
  dark: (r, g, b) => r + g + b < 90,
  darkish: (r, g, b) => r + g + b < 250,
  bright: (r, g, b) => r + g + b > 600,
  any: () => true,
};

function classList(spec) {
  if (!spec || spec === true) return ['felt'];
  const names = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!CLASSIFIERS[n]) {
      throw new Error(`unknown classifier '${n}'. Known: ${Object.keys(CLASSIFIERS).join(', ')}`);
    }
  }
  return names;
}

/** First classifier in `names` that matches, or null. */
function classify(names, r, g, b) {
  for (const n of names) if (CLASSIFIERS[n](r, g, b)) return n;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome / CDP
// ─────────────────────────────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`chrome not found at ${explicit}`);
    return explicit;
  }
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('could not find Chrome; pass --chrome <path> or set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async connect(url, { attempts = 40, delay = 250 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((ok, no) => {
          ws.onopen = ok;
          ws.onerror = () => no(new Error('websocket refused'));
        });
        const c = new CDP(ws);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && c.pending.has(msg.id)) {
            const { res: ok, rej } = c.pending.get(msg.id);
            c.pending.delete(msg.id);
            msg.error ? rej(new Error(`${msg.error.message} (${msg.error.code})`)) : ok(msg.result);
          }
        };
        return c;
      } catch (e) { lastErr = e; }
      await sleep(delay);
    }
    throw new Error(`could not open websocket ${url}: ${lastErr ? lastErr.message : 'timeout'}`);
  }

  send(method, params = {}) {
    return new Promise((ok, no) => {
      const id = ++this.id;
      this.pending.set(id, { res: ok, rej: no });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

/** Poll the DevTools HTTP endpoint until Chrome is listening. Note: /json/version
 *  is plain HTTP, NOT a websocket — connecting a WebSocket to it always fails. */
async function waitForCDP(port, { attempts = 60, delay = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) { lastErr = e; }
    await sleep(delay);
  }
  throw new Error(`chrome devtools endpoint on port ${port} never came up${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((ok, no) => {
    const srv = net.createServer();
    srv.on('error', no);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => ok(p));
    });
  });
}

/**
 * Launch headless Chrome, set an EXACT viewport, navigate, and screenshot.
 * The viewport is applied via CDP Emulation.setDeviceMetricsOverride, which is
 * not subject to the real OS window minimum that clamps --window-size.
 */
async function capture(opts) {
  const chrome = findChrome(opts.chrome);
  const w = Number(opts.w) || 1280;
  const h = Number(opts.h) || 800;
  const scale = Number(opts.scale) || 1;
  const wait = opts.wait === undefined ? 1200 : Number(opts.wait);
  const url = opts.url || 'about:blank';

  const profile = mkdtempSync(join(tmpdir(), 'viz-'));
  const port = await freePort();
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
  ];
  if (opts['extra-args']) args.push(...String(opts['extra-args']).split(' ').filter(Boolean));
  args.push('about:blank');

  const child = spawn(chrome, args, { stdio: 'ignore', detached: process.platform !== 'win32' });
  let cdp;
  try {
    const ver = await waitForCDP(port);
    const tgt = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = await CDP.connect(tgt.webSocketDebuggerUrl, { attempts: 20 });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: scale, mobile: false,
    });
    await cdp.send('Page.enable');

    // Deterministic Math.random(), installed BEFORE any page script runs, so the
    // same seed reproduces the same deal, stacks and bot delays. Without this,
    // two captures of a randomly-dealt game differ everywhere and a pixel diff
    // is meaningless. mulberry32: small, fast, good enough for UI replay.
    if (opts.seed !== undefined) {
      const seed = Number(opts.seed) >>> 0;
      const src = `(() => {
        let a = ${seed} >>> 0;
        Math.random = function () {
          a = (a + 0x6D2B79F5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      })();`;
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    }

    await cdp.send('Page.navigate', { url });
    await sleep(wait);

    // optional: wait for a selector to exist before shooting
    if (opts['wait-for']) {
      const sel = String(opts['wait-for']).replace(/'/g, "\\'");
      const deadline = Date.now() + (Number(opts['wait-for-timeout']) || 8000);
      while (Date.now() < deadline) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector('${sel}')`, returnByValue: true,
        });
        if (r.result.value) break;
        await sleep(150);
      }
      await sleep(150);
    }

    // optional: run arbitrary JS before the shot — needed to force UI states that
    // only appear after user interaction (e.g. unhiding the action bar)
    if (opts.eval) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: String(opts.eval), returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`--eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      await sleep(Number(opts['eval-wait']) || 250);
    }

    // geometry readout for requested selectors
    let geom = null;
    if (opts.geom || opts.select) {
      const sels = String(opts.select || '.felt')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const expr = `(() => {
        const out = { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, title: document.title, boxes: {} };
        for (const s of ${JSON.stringify(sels)}) {
          const el = document.querySelector(s);
          if (!el) { out.boxes[s] = null; continue; }
          const r = el.getBoundingClientRect();
          out.boxes[s] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        return JSON.stringify(out);
      })()`;
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      geom = JSON.parse(r.result.value);
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(shot.data, 'base64');
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);

    if (opts.out) writeFileSync(resolve(opts.out), buf);

    return {
      browser: ver.Browser,
      requested: [w, h],
      png: [pngW, pngH],
      exact: pngW === w * scale && pngH === h * scale,
      bytes: buf.length,
      out: opts.out ? resolve(opts.out) : null,
      geometry: geom,
    };
  } finally {
    // Закрытие браузера целиком. Важно: спавнённый chrome.exe — это лаунчер,
    // он сразу выходит, а настоящий браузер живёт под другим PID, поэтому
    // child.kill()/taskkill по child.pid не достают его дочерние процессы
    // (gpu/renderer/utility) — они копятся сотнями. Рабочий путь — штатный
    // Browser.close через browser-level WebSocket; taskkill — запасной вариант.
    if (cdp) { try { cdp.close(); } catch {} }
    await closeBrowser(port);
    await killTree(child);
    if (!opts['keep-profile']) {
      for (let i = 0; i < 10; i++) {
        try { rmSync(profile, { recursive: true, force: true }); } catch {}
        if (!existsSync(profile)) break;
        await sleep(150);
      }
    }
  }
}

/** Штатно закрывает весь Chrome через browser-level WebSocket (Browser.close). */
async function closeBrowser(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return;
    const ver = await res.json();
    if (!ver.webSocketDebuggerUrl) return;
    const b = await CDP.connect(ver.webSocketDebuggerUrl, { attempts: 5, delay: 150 });
    try { await b.send('Browser.close', {}); } catch {}
    b.close();
    await sleep(200);
  } catch {}
}

// Убивает процесс вместе со всеми потомками (Chrome плодит их десятками).
async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
    } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe modes
// ─────────────────────────────────────────────────────────────────────────────

function xRange(img, opt) {
  let x0 = opt.x0 === undefined ? 0 : Number(opt.x0);
  let x1 = opt.x1 === undefined ? img.w - 1 : Number(opt.x1);
  x0 = Math.max(0, x0);
  x1 = Math.min(img.w - 1, x1);
  return [x0, x1];
}

/** Run-length classification of a row or column. */
function modeRuns(img, opt) {
  const names = classList(opt.class);
  const rows = opt._rows.length ? opt._rows : [Number(opt.row) || Math.floor(img.h / 2)];
  const useCol = opt.mode === 'runs-col';
  const minRun = Number(opt['min-run']) || 1;
  const results = [];

  for (const n of rows) {
    let seq = [], labels = [];
    const len = useCol ? img.h : img.w;
    for (let i = 0; i < len; i++) {
      const c = useCol ? px(img, n, i) : px(img, i, n);
      if (!c) { seq.push('.'); labels.push(null); continue; }
      const k = classify(names, c[0], c[1], c[2]);
      seq.push(k ? k[0] : '.');
      labels.push(k);
    }
    // group into ranges
    const ranges = [];
    let start = 0;
    for (let i = 1; i <= len; i++) {
      if (i === len || labels[i] !== labels[start]) {
        if (labels[start] && i - start >= minRun) {
          ranges.push({ class: labels[start], from: start, to: i - 1, n: i - start });
        }
        start = i;
      }
    }
    results.push({ at: n, axis: useCol ? 'col' : 'row', seq: seq.join(''), ranges });
  }
  return { mode: useCol ? 'runs-col' : 'runs', classes: names, results };
}

/** First/last matching pixel from each side of a row, with an optional min run. */
function modeEdge(img, opt) {
  const names = classList(opt.class);
  const rows = opt._rows.length ? opt._rows : [Number(opt.row) || Math.floor(img.h / 2)];
  const minRun = Number(opt['min-run']) || 1;
  const [x0, x1] = xRange(img, opt);
  const results = [];

  for (const y of rows) {
    const hit = [];
    for (let x = x0; x <= x1; x++) {
      const c = px(img, x, y);
      hit.push(c && classify(names, c[0], c[1], c[2]) ? 1 : 0);
    }
    const runFrom = (i, dir) => {
      let n = 0, j = i;
      while (j >= 0 && j < hit.length && hit[j]) { n++; j += dir; }
      return n;
    };
    let L = -1, R = -1;
    for (let i = 0; i < hit.length; i++) if (hit[i] && runFrom(i, 1) >= minRun) { L = x0 + i; break; }
    for (let i = hit.length - 1; i >= 0; i--) if (hit[i] && runFrom(i, -1) >= minRun) { R = x0 + i; break; }
    const total = hit.reduce((a, b) => a + b, 0);
    results.push({ y, L, R, span: L >= 0 && R >= 0 ? R - L : -1, count: total });
  }
  return { mode: 'edge', classes: names, minRun, x0, x1, results };
}

/** Per-row count of each classifier over an x-range; flags contiguous bands. */
function modeBand(img, opt) {
  const names = classList(opt.class);
  const [x0, x1] = xRange(img, opt);
  const y0 = Math.max(0, opt.y0 === undefined ? 0 : Number(opt.y0));
  const y1 = Math.min(img.h - 1, opt.y1 === undefined ? img.h - 1 : Number(opt.y1));
  const minCount = Number(opt['min-count']) || 1;
  const results = [];

  for (let y = y0; y <= y1; y++) {
    const counts = {};
    for (const n of names) counts[n] = 0;
    let sum = 0;
    for (let x = x0; x <= x1; x++) {
      const c = px(img, x, y);
      if (!c) continue;
      sum += c[0] + c[1] + c[2];
      const k = classify(names, c[0], c[1], c[2]);
      if (k) counts[k]++;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    results.push({ y, counts, total, sum, hit: total >= minCount });
  }

  // contiguous bands where the row qualifies
  const bands = [];
  let start = null;
  for (let i = 0; i <= results.length; i++) {
    const on = i < results.length && results[i].hit;
    if (on && start === null) start = i;
    if (!on && start !== null) {
      bands.push({ from: results[start].y, to: results[i - 1].y, h: results[i - 1].y - results[start].y + 1 });
      start = null;
    }
  }
  return { mode: 'band', classes: names, x0, x1, minCount, results, bands };
}

/** Raw pixel dump along rows or columns. */
function modeDump(img, opt) {
  const rows = opt._rows.length ? opt._rows : [];
  const cols = opt._cols.length ? opt._cols : [];
  const step = Number(opt.step) || 1;  const y0 = opt.y0 === undefined ? 0 : Number(opt.y0);
  const y1 = opt.y1 === undefined ? img.h - 1 : Number(opt.y1);
  const x0 = opt.x0 === undefined ? 0 : Number(opt.x0);
  const x1 = opt.x1 === undefined ? img.w - 1 : Number(opt.x1);
  const lines = [];

  for (const y of rows) {
    const parts = [];
    for (let x = Math.max(0, x0); x <= Math.min(img.w - 1, x1); x += step) {
      const c = px(img, x, y);
      if (c) parts.push(`${x}:${c[0]},${c[1]},${c[2]}`);
    }
    lines.push({ label: `row y=${y}`, values: parts });
  }
  for (const x of cols) {
    const parts = [];
    for (let y = Math.max(0, y0); y <= Math.min(img.h - 1, y1); y += step) {
      const c = px(img, x, y);
      if (c) parts.push(`${y}:${c[0]},${c[1]},${c[2]}`);
    }
    lines.push({ label: `col x=${x}`, values: parts });
  }
  return { mode: 'dump', classes: classList(opt.class), step, lines };
}

/** Last matching y scanning down each column (finds where a surface ends). */
function modeLast(img, opt) {
  const names = classList(opt.class);
  const cols = opt._cols.length ? opt._cols : [Number(opt.col) || Math.floor(img.w / 2)];
  const y0 = Math.max(0, opt.y0 === undefined ? 0 : Number(opt.y0));
  const y1 = Math.min(img.h - 1, opt.y1 === undefined ? img.h - 1 : Number(opt.y1));
  const results = [];
  for (const x of cols) {
    let last = -1;
    for (let y = y0; y <= y1; y++) {
      const c = px(img, x, y);
      if (c && classify(names, c[0], c[1], c[2])) last = y;
    }
    results.push({ x, lastY: last, fromBottom: last >= 0 ? img.h - 1 - last : -1 });
  }
  return { mode: 'last', classes: names, y0, y1, results };
}

// ─────────────────────────────────────────────────────────────────────────────
// Arc — angular scan around a centre. Answers "which way does the ring turn?"
// and "how long is the arc right now?"  Angle 0° is 12 o'clock, increasing
// clockwise (screen coordinates), so a leading edge that grows in degrees is a
// clockwise sweep.
// ─────────────────────────────────────────────────────────────────────────────

/** Classify the ring at `deg`, walking outward from rIn to rOut. */
function sampleArc(img, cx, cy, rIn, rOut, names, deg) {
  const steps = Math.max(1, Math.round(rOut - rIn));
  for (let s = 0; s <= steps; s++) {
    const r = rIn + s;
    const rad = (deg - 90) * Math.PI / 180;
    const c = px(img, Math.round(cx + r * Math.cos(rad)), Math.round(cy + r * Math.sin(rad)));
    if (!c) continue;
    const k = classify(names, c[0], c[1], c[2]);
    if (k) return k;
  }
  return null;
}

function modeArc(img, opt) {
  const names = classList(opt.class);
  const cx = Number(opt.cx);
  const cy = Number(opt.cy);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    throw new Error('arc mode requires --cx and --cy (ring centre in image pixels)');
  }
  const rIn = Number(opt.r) || 30;
  const rOut = Number(opt.r2) || rIn + 2;
  const step = Number(opt.step) || 1;

  const samples = [];
  for (let deg = 0; deg < 360; deg += step) {
    samples.push({ deg, k: sampleArc(img, cx, cy, rIn, rOut, names, deg) });
  }

  // contiguous runs of every non-null class, wrapping across 0°
  const hits = samples.filter((s) => s.k);
  const runs = [];
  const uniform = hits.length === samples.length && hits.every((s) => s.k === hits[0].k);
  if (uniform) {
    runs.push({ k: hits[0].k, from: 0, to: 360 - step, span: 360 });
  } else if (hits.length) {
    const first = samples.findIndex((s) => s.k);
    let cur = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[(first + i) % samples.length];
      if (s.k) {
        // смена класса начинает новый прогон: так видно и пробел, и границы цветов
        if (!cur || s.k !== cur.k) {
          if (cur) runs.push(cur);
          cur = { k: s.k, from: s.deg, to: s.deg, span: step };
        } else {
          cur.to = s.deg; cur.span += step;
        }
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
  }

  const byClass = {};
  for (const s of samples) if (s.k) byClass[s.k] = (byClass[s.k] || 0) + 1;

  return {
    mode: 'arc', classes: names, cx, cy, rIn, rOut, step,
    covered: hits.length, coverageDeg: hits.length * step,
    byClass, runs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff
// ─────────────────────────────────────────────────────────────────────────────

function diffImages(a, b, opt) {
  if (a.w !== b.w || a.h !== b.h) {
    return {
      sameSize: false,
      aSize: [a.w, a.h],
      bSize: [b.w, b.h],
      error: 'images differ in size; crop them to a common region first',
    };
  }
  const { w, h } = a;
  const n = w * h;
  const heat = opt.heatmap ? Buffer.alloc(n * 4, 255) : null;
  const threshold = opt.threshold === undefined ? 0 : Number(opt.threshold);

  let sumAbs = 0, maxAbs = 0, overThreshold = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  // coarse 16x16 grid of mean difference, for "where does it differ" at a glance
  const gx = 16, gy = 16;
  const grid = Array.from({ length: gy }, () => new Array(gx).fill(0));
  const gridN = Array.from({ length: gy }, () => new Array(gx).fill(0));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      sumAbs += d;
      if (d > maxAbs) maxAbs = d;
      if (d > threshold) {
        overThreshold++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const cell = Math.floor((y / h) * gy) * gx + Math.floor((x / w) * gx);
      grid[Math.floor(cell / gx)][cell % gx] += d;
      gridN[Math.floor(cell / gx)][cell % gx]++;
      if (heat) {
        const v = Math.min(255, d);
        heat[i] = v; heat[i + 1] = v; heat[i + 2] = v; heat[i + 3] = 255;
      }
    }
  }

  const meanGrid = grid.map((row, r) => row.map((s, c) => Math.round(s / Math.max(1, gridN[r][c]))));

  // rank cells by mean difference so the worst regions surface first
  const cells = [];
  for (let r = 0; r < gy; r++) {
    for (let c = 0; c < gx; c++) {
      cells.push({
        y0: Math.round((r / gy) * h), y1: Math.round(((r + 1) / gy) * h) - 1,
        x0: Math.round((c / gx) * w), x1: Math.round(((c + 1) / gx) * w) - 1,
        mean: meanGrid[r][c],
      });
    }
  }
  cells.sort((p, q) => q.mean - p.mean);

  return {
    sameSize: true,
    size: [w, h],
    pixels: n,
    meanAbsDiff: sumAbs / n / 3,
    meanAbsDiffTotal: sumAbs / n,
    maxAbsDiff: maxAbs,
    threshold,
    pixelsOverThreshold: overThreshold,
    fractionOverThreshold: overThreshold / n,
    bbox: maxX >= 0 ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null,
    worstCells: cells.slice(0, 8),
    heatmap: heat,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Crop / scale (nearest-neighbour: honest for reading individual pixels)
// ─────────────────────────────────────────────────────────────────────────────

function cropScale(img, opt) {
  const [cx, cy, cw, ch] = String(opt.crop || `0,0,${img.w},${img.h}`).split(',').map(Number);
  const scale = Number(opt.scale) || 1;
  const x0 = Math.max(0, Math.min(img.w - 1, cx));
  const y0 = Math.max(0, Math.min(img.h - 1, cy));
  const w = Math.max(1, Math.min(img.w - x0, cw));
  const h = Math.max(1, Math.min(img.h - y0, ch));
  const ow = Math.round(w * scale), oh = Math.round(h * scale);
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = x0 + Math.floor(x / scale);
      const sy = y0 + Math.floor(y / scale);
      const si = (sy * img.w + sx) * 4;
      const di = (y * ow + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = 255;
    }
  }
  // optional grid overlay with coordinate labels every `grid` px (in source space)
  return { buf: encodePNG(ow, oh, out), w: ow, h: oh, crop: [x0, y0, w, h], scale };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side-by-side composite (the README comparison image)
// ─────────────────────────────────────────────────────────────────────────────

/** Place images left-to-right on a solid background, top-aligned. */
function side(imgA, imgB, opt) {
  const gap = opt.gap === undefined ? 12 : Number(opt.gap);
  const [br, bg, bb] = String(opt.bg || '4,6,12').split(',').map(Number);
  const h = Math.max(imgA.h, imgB.h);
  const w = imgA.w + gap + imgB.w;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = br; out[i * 4 + 1] = bg; out[i * 4 + 2] = bb; out[i * 4 + 3] = 255;
  }
  const blit = (img, dx) => {
    for (let y = 0; y < img.h; y++) {
      const src = y * img.w * 4;
      const dst = (y * w + dx) * 4;
      img.data.copy(out, dst, src, src + img.w * 4);
    }
  };
  blit(imgA, 0);
  blit(imgB, imgA.w + gap);
  return { buf: encodePNG(w, h, out), w, h, gap, panels: [[0, imgA.w], [imgA.w + gap, imgB.w]] };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], _rows: [], _cols: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next === undefined || next.startsWith('--') ? true : (i++, next);
      if (key === 'row') out._rows.push(Number(val));
      else if (key === 'col') out._cols.push(Number(val));
      else if (key === 'rows') String(val).split(',').forEach((v) => out._rows.push(Number(v.trim())));
      else if (key === 'cols') String(val).split(',').forEach((v) => out._cols.push(Number(v.trim())));
      else out[key] = val;
    } else out._.push(a);
  }
  return out;
}

function fmtNum(v, d = 2) {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v);
}

function printHuman(cmd, data, opt) {
  if (cmd === 'capture') {
    console.log(`browser   ${data.browser}`);
    console.log(`viewport  ${data.requested[0]}x${data.requested[1]} requested`);
    console.log(`png       ${data.png[0]}x${data.png[1]}  ${data.exact ? 'EXACT MATCH' : '*** SIZE MISMATCH ***'}`);
    console.log(`bytes     ${data.bytes}`);
    if (data.out) console.log(`saved     ${data.out}`);
    if (data.geometry) {
      const g = data.geometry;
      console.log(`inner     ${g.viewport[0]}x${g.viewport[1]}  dpr=${g.dpr}`);
      for (const [sel, box] of Object.entries(g.boxes)) {
        console.log(box ? `  ${sel.padEnd(34)} x=${box.x} y=${box.y} w=${box.w} h=${box.h}` : `  ${sel.padEnd(34)} (not found)`);
      }
    }
    return;
  }

  if (cmd === 'probe') {
    const d = data;
    console.log(`file      ${opt.file}`);
    console.log(`mode      ${d.mode}   classes: ${d.classes.join(', ')}${d.minRun > 1 ? `   min-run=${d.minRun}` : ''}`);
    console.log('');
    if (d.mode === 'runs') {
      for (const r of d.results) {
        console.log(`${r.axis} ${r.at}`);
        console.log(`  ${r.seq}`);
        if (r.ranges.length) {
          console.log('  ' + r.ranges.map((x) => `${x.class}:${x.from}-${x.to}(${x.n})`).join('  '));
        } else console.log('  (no matches)');
      }
    } else if (d.mode === 'edge') {
      console.log('    y |    L |    R | span | count');
      console.log('  ----+------+------+------+------');
      for (const r of d.results) {
        console.log(`  ${String(r.y).padStart(4)}|${String(r.L).padStart(6)}|${String(r.R).padStart(6)}|${String(r.span).padStart(6)}|${String(r.count).padStart(6)}`);
      }
    } else if (d.mode === 'band') {
      const names = d.classes;
      console.log('    y | ' + names.map((n) => n.padStart(6)).join(' | ') + ' |  total |    sum');
      console.log('  ----+' + names.map(() => '-------+').join('') + '--------+-------');
      for (const r of d.results) {
        if (opt.all !== true && !r.hit) continue;
        console.log(`  ${String(r.y).padStart(4)}| ` + names.map((n) => String(r.counts[n]).padStart(6)).join(' | ') + ` |${String(r.total).padStart(7)} |${String(r.sum).padStart(7)}`);
      }
      console.log('');
      if (d.bands.length) {
        console.log('bands: ' + d.bands.map((b) => `y${b.from}-${b.to} (h=${b.h})`).join('  '));
      } else console.log('bands: none');
    } else if (d.mode === 'dump') {
      for (const l of d.lines) console.log(`${l.label}\n  ${l.values.join(' ')}`);
    } else if (d.mode === 'last') {
      console.log('    x | lastY | fromBottom');
      console.log('  ----+-------+-----------');
      for (const r of d.results) console.log(`  ${String(r.x).padStart(4)}|${String(r.lastY).padStart(7)}|${String(r.fromBottom).padStart(11)}`);
    } else if (d.mode === 'arc') {
      console.log(`centre    cx=${d.cx} cy=${d.cy}  r=${d.rIn}..${d.rOut}  step=${d.step}°`);
      console.log(`coverage  ${d.coverageDeg}° of 360°`);
      const by = Object.entries(d.byClass);
      console.log('by class  ' + (by.length ? by.map(([k, n]) => `${k}:${n}°`).join('  ') : '(nothing matched)'));
      console.log('');
      console.log('arcs (0°=12 o\'clock, degrees grow clockwise):');
      for (const r of d.runs) {
        console.log(`  ${r.k.padEnd(8)} ${String(r.from).padStart(3)}° → ${String(r.to).padStart(3)}°   span ${r.span}°`);
      }
    }
    return;
  }

  if (cmd === 'diff') {
    const d = data;
    console.log(`a         ${opt.a}`);
    console.log(`b         ${opt.b}`);
    if (!d.sameSize) {
      console.log(`SIZE MISMATCH  a=${d.aSize.join('x')}  b=${d.bSize.join('x')}`);
      console.log(d.error);
      return;
    }
    console.log(`size      ${d.size[0]}x${d.size[1]} (${d.pixels} px)`);
    console.log(`mean |Δ|  ${d.meanAbsDiff.toFixed(3)} per channel   (${d.meanAbsDiffTotal.toFixed(2)} summed)`);
    console.log(`max  |Δ|  ${d.maxAbsDiff}  (765 = every channel maximally different)`);
    console.log(`over ${String(d.threshold).padStart(3)}   ${d.pixelsOverThreshold} px  (${(d.fractionOverThreshold * 100).toFixed(2)}%)`);
    if (d.bbox) console.log(`bbox      x${d.bbox.x0}-${d.bbox.x1}  y${d.bbox.y0}-${d.bbox.y1}`);
    console.log('\nworst 16x16 cells (mean |Δ| per pixel):');
    for (const c of d.worstCells) {
      console.log(`  mean ${String(c.mean).padStart(4)}   x${c.x0}-${c.x1}  y${c.y0}-${c.y1}`);
    }
    return;
  }

  if (cmd === 'crop') {
    console.log(`crop      x${data.crop[0]} y${data.crop[1]} w${data.crop[2]} h${data.crop[3]}  scale=${data.scale}`);
    console.log(`output    ${data.w}x${data.h}`);
    if (opt.out) console.log(`saved     ${resolve(opt.out)}`);
    return;
  }

  if (cmd === 'side') {
    console.log(`output    ${data.w}x${data.h}   gap=${data.gap}`);
    data.panels.forEach((p, i) => console.log(`  panel ${i === 0 ? 'A' : 'B'}  x=${p[0]}  w=${p[1]}`));
    if (data.out) console.log(`saved     ${data.out}`);
    return;
  }

  if (cmd === 'classes') {
    for (const [name, fn] of Object.entries(CLASSIFIERS)) {
      console.log(`  ${name.padEnd(12)} ${fn.toString().replace(/^\(r, g, b\) => /, '')}`);
    }
    return;
  }
}

const USAGE = `
viz.mjs — pixel-accurate capture, measurement and diffing for UI work.
Zero dependencies beyond Node >= 20 (uses the built-in fetch/WebSocket for CDP).

CAPTURE — screenshot at an exact viewport, immune to the OS window minimum
  --url <url>            page to load
  --w <px> --h <px>      exact viewport size (required for reproducibility)
  --out <file.png>       where to save
  --scale <n>            device scale factor (default 1)
  --wait <ms>            settle time after navigation (default 1200)
  --wait-for <selector>  also wait until this element exists
  --eval "<js>"          run JS before the shot (force states, freeze animations)
  --eval-wait <ms>       settle time after --eval (default 250)
  --seed <n>             seed Math.random() before page scripts (repeatable frames)
  --select <css,...>     print bounding boxes for these selectors
  --geom                 print full geometry readout (viewport, document, boxes)
  --chrome <path>        explicit Chrome/Edge binary
  --extra-args "<...>"   extra Chrome flags
  --keep-profile         do not delete the temp browser profile

PROBE — measure geometry in a saved screenshot
  --file <file.png>
  --mode runs|edge|band|dump|last|runs-col|arc     (default: runs)
  --class <name,...>     comma-separated classifiers (see 'classes')
  --row <y> | --rows a,b,c        rows to scan
  --col <x> | --cols a,b,c        columns (for dump / last / runs-col)
  --x0 --x1 --y0 --y1             scan window
  --min-run <n>          minimum run length for runs/edge (default 1)
  --min-count <n>        minimum matches for a band row (default 1)
  --all                  band mode: print non-matching rows too
  --step <n>             dump mode: pixel step (default 1); arc mode: degree step

ARC MODE — walk a circle and report which class covers which sector
  --cx <x> --cy <y>      circle centre in image pixels
  --r <px> --r2 <px>     inner/outer radius of the corridor to sample
  Angles are printed with 0° at 12 o'clock, growing clockwise. A sector with
  no match is a gap in the ring — that is how the turn-timer drain is verified.

DIFF — compare two screenshots
  --a <ref.png> --b <shot.png>
  --heatmap <out.png>    write |ΔR|+|ΔG|+|ΔB| as greyscale (dark = identical)
  --threshold <n>        count/bbox only pixels above this |Δ| sum

CROP — zoom into a region for visual inspection
  --file <file.png> --crop x,y,w,h --scale <n> --out <file.png>

SIDE — paste two images side by side (top-aligned) for before/after review
  --a <left.png> --b <right.png> --out <file.png> [--gap 12] [--bg r,g,b]

CLASSES — list the colour classifiers and their thresholds

EXAMPLES
  viz.mjs capture --url http://127.0.0.1:8770/ --w 376 --h 696 --out shot.png --select .felt,.act-row
  viz.mjs probe --file shot.png --rows 500 --mode edge --class felt
  viz.mjs probe --file shot.png --rows 668 --mode runs --class red,green,gold --min-run 4
  viz.mjs probe --file shot.png --y0 630 --y1 695 --mode band --class red
  viz.mjs probe --file shot.png --cols 40 --y0 646 --y1 692 --mode dump --step 3
  viz.mjs probe --file shot.png --mode arc --cx 320 --cy 477 --r 32 --r2 38 --class green,gold,red,grey
  viz.mjs diff --a ref.png --b shot.png --heatmap d.png --threshold 30
  viz.mjs crop --file shot.png --crop 0,625,376,71 --scale 3 --out zoom.png
  viz.mjs side --a ref.png --b shot.png --out compare.png

Any command accepts --json for machine-readable output.
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = parseArgs(argv.slice(1));
  const wantJSON = opt.json === true;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || opt.help) {
    console.log(USAGE.trim());
    return 0;
  }

  let data;
  switch (cmd) {
    case 'capture':
      if (!opt.url) throw new Error('capture requires --url');
      data = await capture(opt);
      break;

    case 'probe': {
      if (!opt.file) throw new Error('probe requires --file');
      const img = loadPNG(opt.file);
      const mode = opt.mode || 'runs';
      if (mode === 'runs') data = modeRuns(img, opt);
      else if (mode === 'runs-col') data = modeRuns(img, { ...opt, mode: 'runs-col' });
      else if (mode === 'edge') data = modeEdge(img, opt);
      else if (mode === 'band') data = modeBand(img, opt);
      else if (mode === 'dump') data = modeDump(img, opt);
      else if (mode === 'last') data = modeLast(img, opt);
      else if (mode === 'arc') data = modeArc(img, opt);
      else throw new Error(`unknown mode '${mode}' (runs, runs-col, edge, band, dump, last, arc)`);
      data.file = resolve(opt.file);
      data.size = [img.w, img.h];
      break;
    }

    case 'diff': {
      if (!opt.a || !opt.b) throw new Error('diff requires --a and --b');
      const a = loadPNG(opt.a), b = loadPNG(opt.b);
      data = diffImages(a, b, opt);
      if (data.heatmap) {
        const out = opt.heatmap === true ? 'diff.png' : opt.heatmap;
        writeFileSync(resolve(out), encodePNG(a.w, a.h, data.heatmap));
        data.heatmapFile = resolve(out);
        delete data.heatmap;
      }
      break;
    }

    case 'crop': {
      if (!opt.file) throw new Error('crop requires --file');
      const img = loadPNG(opt.file);
      const r = cropScale(img, opt);
      if (opt.out) writeFileSync(resolve(opt.out), r.buf);
      data = { mode: 'crop', crop: r.crop, w: r.w, h: r.h, scale: r.scale };
      break;
    }

    case 'side': {
      if (!opt.a || !opt.b) throw new Error('side requires --a and --b');
      const r = side(loadPNG(opt.a), loadPNG(opt.b), opt);
      if (opt.out) writeFileSync(resolve(opt.out), r.buf);
      data = { mode: 'side', w: r.w, h: r.h, gap: r.gap, panels: r.panels, out: opt.out ? resolve(opt.out) : null };
      break;
    }

    case 'classes':
      data = { mode: 'classes' };
      break;

    default:
      console.error(`unknown command '${cmd}'\n`);
      console.log(USAGE.trim());
      return 2;
  }

  if (wantJSON) console.log(JSON.stringify(data, null, 2));
  else printHuman(cmd, data, opt);
  return 0;
}

// Запускаем CLI только при прямом вызове (`node tools/viz.mjs …`), чтобы файл
// можно было импортировать как библиотеку: decodePNG/encodePNG/cropScale/diffImages.
const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => { console.error(`error: ${err.message}`); process.exit(1); },
  );
}
