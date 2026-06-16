#!/usr/bin/env node
/**
 * Tile a burst of frames into one labeled contact sheet a vision model can read.
 * The pipeline:
 *   - cumulative-motion keyframe selection (256x256 grayscale mean-abs-diff,
 *     1.5x-90th-percentile clamp, even sampling on the cumulative-motion axis)
 *   - motion-bbox auto-crop (saturating cumulative inter-frame diff)
 *   - grid sizing that maximizes cell size under a vision-model edge budget
 *   - per-cell index/timestamp gutters + optional slowdown header
 *
 * sharp does the heavy image ops (resize/grayscale/composite/encode, native
 * libvips); the three small pixel kernels (mean-abs-diff, saturating-add
 * envelope, bbox threshold) are plain loops over raw buffers.
 *
 *   node scripts/build-sheet.mjs <frames-dir> [--select N] [--max-edge PX]
 *                                [--grid auto|CxR] [--no-crop] [--crop-margin PX]
 *                                [--edges] [--even] [--debug-export] [--out FILE]
 *
 * Sidecar: reads <dir>/meta.json or <dir>/timestamps.json (a wrapped object or a
 * bare timestamps array) for the slowdown factor + per-frame timestamps. Optional.
 *
 * --even bypasses motion selection and samples evenly by frame index (the naive
 * baseline, useful for showing what motion-aware selection buys you: quiet
 * stretches eat cells the motion axis would have skipped). --debug-export writes
 * the raw motion layer (per-frame diffs + cumulative envelope) to _debug/. Note
 * that --edges adds endpoint/launch/settle anchors, so the final cell count can
 * exceed --select. The sheet defaults to <frames-dir>/contact-sheet.png.
 */
import sharp from 'sharp';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_LONG_EDGE = 2576; // Opus 4.x (1M) server-resize ceiling; 1568 for other Claude 4.x

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
// value-taking flags: fail loudly on a missing or non-numeric value rather than
// silently coercing to true / NaN.
function numArg(name, def, min = 1) {
  const raw = arg(name, null);
  if (raw === null) return def;
  const v = Number(raw);
  if (raw === true || !Number.isFinite(v) || v < min) {
    console.error(`error: --${name} needs a number >= ${min}`);
    process.exit(1);
  }
  return v;
}
function strArg(name, def) {
  const raw = arg(name, def);
  if (raw === true) { console.error(`error: --${name} needs a value`); process.exit(1); }
  return raw;
}

// ---- raw grayscale helpers (sharp gives the buffer; we read channel 0) ----
async function grayRaw(input, w, h) {
  let s = sharp(input);
  if (w && h) s = s.resize(w, h, { fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await s.greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return { data, w: info.width, h: info.height };
  const out = Buffer.allocUnsafe(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels];
  return { data: out, w: info.width, h: info.height };
}
const meanAbsDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

// ---- debug export: visualize the motion layer the crop is cut from ----
// One grayscale image per consecutive pair (what changed since the last frame,
// amplified so small motion is visible) + the cumulative saturating "envelope"
// (the motion footprint the crop bbox is cut from), plus the per-frame score
// series (motion.json). This is the full-res signal computeMotionBbox works on;
// the keyframe selector scores a 256x256 clamped version, so it's the same idea,
// not a pixel-identical copy of the selection signal.
async function exportDebug(files, baseDir) {
  const dbg = path.join(baseDir, '_debug');
  await mkdir(dbg, { recursive: true });
  const grays = [];
  let w, h;
  for (const f of files) { const g = await grayRaw(f); grays.push(g.data); w = g.w; h = g.h; }
  const cum = new Uint16Array(w * h);
  const scores = [0];
  for (let i = 1; i < grays.length; i++) {
    const a = grays[i], b = grays[i - 1];
    const diff = Buffer.allocUnsafe(w * h);
    let s = 0;
    for (let p = 0; p < diff.length; p++) {
      const d = Math.abs(a[p] - b[p]);
      diff[p] = Math.min(255, d * 3); // amplify so small motion reads
      cum[p] = Math.min(255, cum[p] + d);
      s += d;
    }
    scores.push(+(s / diff.length).toFixed(3));
    await sharp(diff, { raw: { width: w, height: h, channels: 1 } }).png()
      .toFile(path.join(dbg, `diff-${String(i).padStart(3, '0')}.png`));
  }
  const env = Buffer.allocUnsafe(w * h);
  for (let p = 0; p < env.length; p++) env[p] = cum[p];
  await sharp(env, { raw: { width: w, height: h, channels: 1 } }).png()
    .toFile(path.join(dbg, 'envelope.png'));
  await writeFile(path.join(dbg, 'motion.json'), JSON.stringify({ scores }, null, 2));
  console.log(`debug: ${grays.length - 1} diff frames + envelope → ${dbg}/`);
}

// ---- select_keyframes: cumulative-motion sampling ----
// Always anchors both true endpoints (the initial condition + the final rest)
// so quiet edge states are never lost to the motion axis. With `edges`, also
// densifies the launch + settle windows — where onset (flash/pop-in) and
// release (snap/settle) glitches live, exactly the low-motion frames the
// cumulative axis starves.
function finalizePicks(picks, n, edges) {
  picks.add(0);
  picks.add(n - 1);
  if (edges) {
    for (const f of [0.04, 0.08, 0.12, 0.88, 0.92, 0.96]) picks.add(Math.round((n - 1) * f));
  }
  return [...picks].sort((a, b) => a - b);
}
async function selectKeyframes(frames, nSelect, edges = false) {
  const n = frames.length;
  if (nSelect <= 1) return n ? [0] : [];
  if (n <= nSelect) return [...Array(n).keys()];

  const tiles = [];
  for (const f of frames) tiles.push((await grayRaw(f, 256, 256)).data);
  const motion = [0];
  for (let i = 1; i < n; i++) motion.push(meanAbsDiff(tiles[i], tiles[i - 1]));

  // clamp: cap at 1.5x the 90th percentile (3x median for <10 samples)
  const nonzero = motion.slice(1).filter((m) => m > 0).sort((a, b) => a - b);
  if (nonzero.length >= 10) {
    const cap = nonzero[Math.floor(nonzero.length * 0.9)] * 1.5;
    for (let i = 0; i < motion.length; i++) motion[i] = Math.min(motion[i], cap);
  } else if (nonzero.length) {
    const cap = nonzero[Math.floor((nonzero.length - 1) / 2)] * 3; // median*3
    for (let i = 0; i < motion.length; i++) motion[i] = Math.min(motion[i], cap);
  }

  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + motion[i]);
  const total = cum[n - 1];
  if (total <= 0) {
    const step = (n - 1) / (nSelect - 1);
    return finalizePicks(new Set([...Array(nSelect).keys()].map((k) => Math.round(k * step))), n, edges);
  }
  const picks = new Set();
  for (let k = 0; k < nSelect; k++) {
    const target = (k * total) / (nSelect - 1);
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(cum[i] - target);
      if (d < bd) { bd = d; bi = i; }
    }
    picks.add(bi);
  }
  return finalizePicks(picks, n, edges);
}

// ---- select_even: the naive baseline — evenly spaced by frame index (≈ time),
// blind to where the motion actually is ----
function selectEven(n, nSelect) {
  if (nSelect <= 1) return n ? [0] : [];
  if (n <= nSelect) return [...Array(n).keys()];
  const step = (n - 1) / (nSelect - 1);
  const picks = new Set();
  for (let k = 0; k < nSelect; k++) picks.add(Math.round(k * step));
  return [...picks].sort((a, b) => a - b);
}

// ---- compute_motion_bbox: saturating cumulative diff envelope ----
async function computeMotionBbox(frames, margin = 24) {
  if (!frames.length) return null;
  const first = await grayRaw(frames[0]);
  const { w, h } = first;
  let bbox = null;
  if (frames.length >= 2) {
    const grays = [first.data];
    for (let i = 1; i < frames.length; i++) grays.push((await grayRaw(frames[i])).data);
    const cum = new Uint16Array(w * h);
    for (let i = 1; i < grays.length; i++) {
      const a = grays[i], b = grays[i - 1];
      for (let p = 0; p < cum.length; p++) cum[p] = Math.min(255, cum[p] + Math.abs(a[p] - b[p]));
    }
    let peak = 0;
    for (let p = 0; p < cum.length; p++) if (cum[p] > peak) peak = cum[p];
    if (peak > 0) {
      const thresh = Math.max(8, Math.floor(peak * 0.05));
      let l = w, t = h, r = 0, bot = 0, any = false;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (cum[y * w + x] >= thresh) { any = true; if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > bot) bot = y; }
      }
      if (any) bbox = [l, t, r + 1, bot + 1];
    }
  }
  if (!bbox) return null;
  const [left, top, right, bottom] = bbox;
  return [Math.max(0, left - margin), Math.max(0, top - margin), Math.min(w, right + margin), Math.min(h, bottom + margin)];
}

// ---- parse_grid('auto'): maximize cell size, preserving clip aspect ----
function parseGrid(gridStr, n, aspect) {
  if (gridStr && gridStr !== 'auto') { const [c, r] = gridStr.toLowerCase().split('x').map(Number); return [c, r]; }
  let bestCell = -1, best = [1, n];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const unit = Math.min(1 / cols, aspect / rows);
    if (unit > bestCell) { bestCell = unit; best = [cols, rows]; }
  }
  return best;
}
const fmtTs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- main ----
const dir = process.argv[2];
if (!dir || dir.startsWith('--')) { console.error('error: pass a frames directory'); process.exit(1); }
const nSelect = numArg('select', 12);
const maxEdge = numArg('max-edge', MAX_LONG_EDGE, 64);
const cropMargin = numArg('crop-margin', 24, 0);
const gridArg = strArg('grid', 'auto');
const noCrop = arg('no-crop', false) === true;
const edges = arg('edges', false) === true;
const even = arg('even', false) === true;
const debugExport = arg('debug-export', false) === true;
const outFile = strArg('out', path.join(dir, 'contact-sheet.png'));

// sidecar: "meta.json" (this tool) or "timestamps.json" (a host app's capture),
// either a wrapped object {slowdown, timestamps, ...} or a bare timestamps array.
// All of it is optional (frames build without it).
let meta = {};
for (const name of ['meta.json', 'timestamps.json']) {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    meta = Array.isArray(raw) ? { timestamps: raw } : raw;
    break;
  } catch { /* try the next sidecar name */ }
}
const files = (await readdir(dir)).filter((f) => /^frame[-_]\d+\.png$/i.test(f)).sort()
  .map((f) => path.join(dir, f));
if (!files.length) { console.error('error: no frame-*.png in ' + dir); process.exit(1); }

if (debugExport) await exportDebug(files, dir);

const cropBbox = noCrop ? null : await computeMotionBbox(files, cropMargin);
const selected = even ? selectEven(files.length, nSelect) : await selectKeyframes(files, nSelect, edges);
const N = selected.length;

// frame aspect (post-crop)
let frameW, frameH;
if (cropBbox) { frameW = cropBbox[2] - cropBbox[0]; frameH = cropBbox[3] - cropBbox[1]; }
else { const m = await sharp(files[selected[0]]).metadata(); frameW = m.width; frameH = m.height; }
const aspect = frameW / frameH;
const [cols, rows] = parseGrid(gridArg, N, aspect);
const cells = Math.min(N, cols * rows); // an explicit --grid may hold fewer cells than selected
if (cols * rows < N) console.error(`warning: grid ${cols}x${rows} holds ${cols * rows} cells but ${N} frames selected; dropping ${N - cols * rows}`);

// ---- sizing (mirror build_contact_sheet) ----
const slowdown = meta.slowdown && meta.slowdown !== 1 ? meta.slowdown : null;
const gutterReservePerRow = 40;
const headerH = slowdown != null ? 80 : 0;
const effMaxH = maxEdge - rows * gutterReservePerRow - headerH;
if (effMaxH < rows * 40) { console.error(`error: --max-edge ${maxEdge} too small for ${rows} rows; raise --max-edge or lower --select/--grid`); process.exit(1); }
const sheetAspect = (cols * frameW) / (rows * frameH);
let imageAreaH, sheetW;
if (Math.floor(effMaxH * sheetAspect) <= maxEdge) { imageAreaH = effMaxH; sheetW = Math.floor(effMaxH * sheetAspect); }
else { sheetW = maxEdge; imageAreaH = Math.floor(maxEdge / sheetAspect); }
const imageCellW = Math.floor(sheetW / cols);
const imageCellH = Math.floor(imageAreaH / rows);
const gutterH = Math.max(28, Math.min(56, Math.floor(imageCellH / 12)));
const cellW = imageCellW, cellH = imageCellH + gutterH;
const SW = cellW * cols, SH = cellH * rows + headerH;
if (Math.min(imageCellW, imageCellH) < 400) console.error(`warning: cell ${imageCellW}x${imageCellH} < 400px — fine motion may blur`);

// timestamps (native = wall / slowdown)
const ts = (meta.timestamps || []).map((t) => Math.round(t / (slowdown || 1)));
const deltas = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
const medianDelta = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;

// ---- composite frames + SVG overlay ----
const layers = [];
const svgParts = [];
if (headerH) {
  svgParts.push(`<rect x="0" y="0" width="${SW}" height="${headerH}" fill="rgb(28,28,38)"/>`);
  svgParts.push(`<text x="24" y="${Math.round(headerH * 0.62)}" font-family="sans-serif" font-weight="700" font-size="${Math.round(headerH * 0.42)}" fill="rgb(200,220,255)">Slowdown: ${slowdown}x  (gutter labels are native time; capture was slowed ${slowdown}x)</text>`);
}
for (let i = 0; i < cells; i++) {
  const col = i % cols, row = Math.floor(i / cols);
  const cellX = col * cellW, cellY = headerH + row * cellH;
  const imageY = cellY + gutterH;
  // resize the (optionally cropped) frame to fit the image cell, centered
  let img = sharp(files[selected[i]]);
  if (cropBbox) img = img.extract({ left: cropBbox[0], top: cropBbox[1], width: frameW, height: frameH });
  const buf = await img.resize(imageCellW, imageCellH, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  const m = await sharp(buf).metadata();
  const x = cellX + Math.floor((imageCellW - m.width) / 2);
  const y = imageY + Math.floor((imageCellH - m.height) / 2);
  layers.push({ input: buf, left: x, top: y });
  // gutter bg + border + label (SVG, on top)
  svgParts.push(`<rect x="${cellX}" y="${cellY}" width="${cellW}" height="${gutterH}" fill="rgb(38,38,48)"/>`);
  svgParts.push(`<rect x="${cellX + 1}" y="${imageY + 1}" width="${cellW - 2}" height="${imageCellH - 2}" fill="none" stroke="rgb(180,180,200)" stroke-width="2"/>`);
  const fs = Math.max(16, Math.floor(gutterH * 0.55));
  const ii = String(i).padStart(2, '0'); // selected-sequence index
  let label, color = 'rgb(255,230,110)';
  if (ts.length) {
    if (i === 0) label = `${ii}   t0`;
    else {
      const d = ts[selected[i]] - ts[selected[i - 1]];
      label = `${ii}   +${fmtTs(d)}`;
      if (medianDelta && d > medianDelta * 1.5) color = 'rgb(140,220,255)';
    }
  } else label = ii;
  svgParts.push(`<text x="${cellX + 12}" y="${cellY + Math.round(gutterH * 0.7)}" font-family="sans-serif" font-weight="700" font-size="${fs}" fill="${color}">${esc(label)}</text>`);
}
const svg = `<svg width="${SW}" height="${SH}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`;
layers.push({ input: Buffer.from(svg), left: 0, top: 0 });

await sharp({ create: { width: SW, height: SH, channels: 3, background: { r: 18, g: 18, b: 22 } } })
  .composite(layers).png().toFile(outFile);

// ---- markdown companion: a readable per-cell table that survives the image
// being downscaled past label legibility (for the model AND for humans) ----
const mdLines = [
  `# Contact sheet — ${path.basename(dir)}`,
  '',
  `${slowdown ? `Slowdown ${slowdown}× · times below are native · ` : ''}grid ${cols}×${rows} · ${cells}/${files.length} frames${cropBbox ? ` · crop [${cropBbox.join(',')}]` : ''}`,
  '',
  '| cell | source frame | native time |',
  '| --- | --- | --- |',
];
selected.slice(0, cells).forEach((idx, i) => {
  const t = ts.length ? (i === 0 ? 't0' : `+${fmtTs(ts[selected[i]] - ts[selected[i - 1]])}`) : '—';
  mdLines.push(`| ${String(i).padStart(2, '0')} | ${path.basename(files[idx])} | ${t} |`);
});
const mdFile = outFile.replace(/\.png$/i, '.md');
await writeFile(mdFile, mdLines.join('\n') + '\n');

console.log(`sheet: ${outFile}  ${SW}x${SH}px  grid ${cols}x${rows}  cell ${imageCellW}x${imageCellH}px  from ${N}/${files.length} frames` + (cropBbox ? `  crop [${cropBbox.join(',')}]` : ''));
console.log(`markdown: ${mdFile}`);
console.log(`selected: ${selected.join(', ')}`);
