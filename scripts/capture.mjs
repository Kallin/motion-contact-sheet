#!/usr/bin/env node
/**
 * Capture a timed burst of screenshots across a running UI animation.
 *
 *   node scripts/capture.mjs --url <url> [options]
 *
 * Options:
 *   --url <url>        Page to capture (http(s):// or file://). Required.
 *   --play "<expr>"    JS expression to (re)start the animation, e.g.
 *                      "window.play()" or "document.querySelector('.btn').click()".
 *   --clip <selector>  CSS selector for the region to clip each frame to.
 *                      Strongly recommended — without it you capture the whole
 *                      viewport and the motion is a thumbnail in the corner.
 *   --slowdown <n>     Slow animations by n× so the burst samples fine motion
 *                      (default 1 = native speed). Slows BOTH CSS/WAAPI
 *                      animations (document.getAnimations()) AND a GSAP global
 *                      timeline if window.gsap is present — auto-detected, so a
 *                      GSAP-driven app needs no extra flag.
 *   --count <n>        Frames to capture (default 60). Oversample; the sheet
 *                      builder selects the meaningful ones.
 *   --interval <ms>    Target ms between frames (default 80).
 *   --out <dir>        Output directory for frames + meta.json (default ./frames).
 *   --viewport <WxH>   Browser viewport (default 1000x700).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
// value-taking flags: fail loudly on a missing or non-numeric value rather than
// silently coercing to true / NaN.
function numArg(name, def, min = 0) {
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

const url = strArg('url', null);
if (!url) {
  console.error('error: --url is required');
  process.exit(1);
}
const playExpr = strArg('play', null);
const clip = strArg('clip', null);
const slowdown = numArg('slowdown', 1, 0.01);
const count = numArg('count', 60, 1);
const interval = numArg('interval', 80, 0);
const out = strArg('out', 'frames');
const [vw, vh] = strArg('viewport', '1000x700').split('x').map(Number);
if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw < 1 || vh < 1) {
  console.error('error: --viewport must be WxH, e.g. 1280x720');
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
await page.goto(url, { waitUntil: 'load' });

// Bring the clip target into view first, so the burst's clip box sits inside the
// viewport screenshot. A below-the-fold demo otherwise clips out of bounds.
if (clip) {
  await page.locator(clip).first().scrollIntoViewIfNeeded().catch(() => {});
}

// Trigger the animation and immediately slow every running animation, so the
// burst samples slowed motion from (near) the first frame.
await page.evaluate(
  ({ playExpr, slowdown }) => {
    if (playExpr) {
      try { new Function(playExpr)(); } catch (e) { console.error('play expr failed:', e); }
    }
    const rate = 1 / slowdown;
    // CSS / WAAPI animations.
    for (const a of document.getAnimations()) {
      if (a.updatePlaybackRate) a.updatePlaybackRate(rate);
      else a.playbackRate = rate;
    }
    // GSAP timelines. Auto-detected: getAnimations() can't see GSAP tweens, so
    // a GSAP-driven app would otherwise capture at full speed (a blur) while
    // the sheet still claimed the slowdown. Slowing the global timeline fixes
    // that with no extra flag.
    if (window.gsap?.globalTimeline) {
      window.gsap.globalTimeline.timeScale(rate);
    }
  },
  { playExpr, slowdown },
);

const rect = clip ? await page.locator(clip).first().boundingBox() : null;
if (clip && !rect) {
  console.error(`error: --clip selector "${clip}" matched nothing visible`);
  await browser.close();
  process.exit(1);
}

const timestamps = [];
const t0 = Date.now();
for (let i = 0; i < count; i++) {
  const elapsed = Date.now() - t0;
  await page.screenshot({
    path: path.join(out, `frame-${String(i).padStart(3, '0')}.png`),
    ...(rect ? { clip: rect } : {}),
  });
  timestamps.push(elapsed);
  await page.waitForTimeout(interval);
}

await writeFile(
  path.join(out, 'meta.json'),
  JSON.stringify({ url, slowdown, interval, count, clip, rect, timestamps }, null, 2),
);
await browser.close();
console.log(`captured ${count} frames → ${out}/  (slowdown ${slowdown}×, ~${timestamps.at(-1)}ms wall)`);
