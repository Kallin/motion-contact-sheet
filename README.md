# motion-contact-sheet

Give a coding agent eyes for motion. Capture a running UI animation as a timed
screenshot burst, tile it into one labeled **contact sheet**, and hand that single
image to a vision-capable agent so it can actually *see* how the motion looks, not
just that the tests pass.

Coding agents are blind to animation. They read the test log, watch it go green, and
never notice that the card snaps the last few pixels into place, or flashes for a frame
before it flies. A contact sheet turns "perceive motion over time" (which agents are bad
at) into "read one picture" (which they're good at).

**Full write-up, with live demos:** [Giving Coding Agents Eyes for Motion](https://kallin.github.io/blog/agents-eyes-for-motion/)

## Install

```bash
npm install
npx playwright install chromium
npm link              # optional: exposes `mcs-capture` and `mcs-sheet` on your PATH
```

Dependencies are just [playwright](https://playwright.dev) (the burst) and
[sharp](https://sharp.pixelplumbing.com) (the tiling).

## Use

Two steps: burst-capture the animation against a running page, then tile it.

```bash
# 1. capture (slow it down so the frames land on the motion, clip to what moves)
mcs-capture --url http://localhost:3000 --clip ".toast" --slowdown 6 --out frames/

# 2. tile into one labeled contact sheet
mcs-sheet frames/ --edges
```

Open `frames/contact-sheet.png`, or have your agent read it. A `.md` companion lands
next to it with a per-cell timing table that stays readable after the image is downscaled.

### The three things that matter

- **Slow it down.** A browser screenshot has a floor around 40-50 ms, so a 200 ms
  transition gives you two or three usable frames. `--slowdown 6` stretches the animation
  so the burst can sample it; the sheet header records the factor and the labels report
  native time. Slow it enough that the whole animation fits the capture window:
  `count x interval` (wall-clock) needs to exceed `duration x slowdown`. It slows both
  CSS/WAAPI animations and a GSAP global timeline (auto-detected), so it works whether your
  motion is CSS transitions or GSAP tweens. This matters: `getAnimations()` can't see GSAP
  tweens, so without the GSAP path a GSAP-driven app would capture at full speed (a blur)
  while the sheet still claimed the slowdown.
- **Clip to the motion.** `--clip "<css-selector>"` captures only the region that moves.
  Without it the motion is a thumbnail in a sea of static chrome. The builder also
  auto-crops to the bounding box of pixels that actually change.
- **`--edges` for end-state bugs.** Snaps and flashes live in the first and last few
  frames, exactly where motion-aware sampling is thinnest. `--edges` densifies the launch
  and settle windows so they don't get skipped.

### `mcs-capture`

| flag | default | what |
| --- | --- | --- |
| `--url` | (required) | page to capture (`http(s)://` or `file://`) |
| `--clip` | none | CSS selector for the region to clip each frame to |
| `--play` | none | JS to (re)start the animation, e.g. `"document.querySelector('.btn').click()"` |
| `--slowdown` | 1 | slow animations by N — both CSS/WAAPI (`getAnimations()`) and a GSAP global timeline if `window.gsap` is present (auto-detected, no extra flag) |
| `--count` | 60 | frames to capture (oversample; the builder keeps the meaningful ones) |
| `--interval` | 80 | target ms between frames |
| `--viewport` | `1000x700` | browser viewport, `WxH` |
| `--out` | `frames` | output directory |

### `mcs-sheet`

| flag | default | what |
| --- | --- | --- |
| `<frames-dir>` | (required) | directory of `frame-*.png` + a `meta.json`/`timestamps.json` sidecar |
| `--select` | 12 | keyframes to keep (`--edges` adds a few endpoint/launch/settle anchors on top) |
| `--edges` | off | densify the launch + settle windows (catch flash / snap) |
| `--no-crop` | off | disable auto-crop to the motion bounding box |
| `--crop-margin` | 24 | padding (px) around the crop box |
| `--even` | off | sample evenly by time instead of by motion (the naive baseline) |
| `--debug-export` | off | write the raw motion layer to `<dir>/_debug/`: per-frame B&W diffs, the cumulative envelope, and a motion-score series |
| `--max-edge` | 2576 | vision-model long-edge budget, in px |
| `--grid` | `auto` | `auto`, or an explicit `CxR` |
| `--out` | `<frames-dir>/contact-sheet.png` | output file |

## Hook it to your agent

The loop is: **you describe the artifact, the agent captures and looks, fixes, then
re-captures to confirm.** You supply the intent; the sheet supplies the eyes. It is not
autonomous bug-hunting.

Any agent with a shell, image-reading, and Node works (Claude Code, Cursor agent mode).
**Don't run the burst through a browser MCP.** The per-screenshot round trip (~300-500 ms)
is far too slow for a 60-200 ms cadence. Use an MCP, or `--play`, only to *stage* the
scene; run the burst in-process.

A drop-in Claude Code skill lives in [`.claude/skills/contact-sheet/`](.claude/skills/contact-sheet/SKILL.md).
Copy it into your project's `.claude/skills/`, and the agent reaches for the tool on its
own whenever you describe something that looks wrong in motion.

## How it works

`build-sheet` oversamples, scores each frame by how much it changed from the previous one
(a grayscale mean-absolute-difference), and samples the keepers along *cumulative motion*,
so quiet stretches collapse to a frame or two and busy moments oversample. It auto-crops to
where the pixels actually move, and sizes the grid so each cell is as large as a vision
model's edge budget allows. The [blog post](https://kallin.github.io/blog/agents-eyes-for-motion/)
walks through each step with live demos.

## License

MIT
