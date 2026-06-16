---
name: contact-sheet
description: When the user describes a UI animation or transition that looks wrong (a snap, flash, jump, stutter, jank, wrong easing, wrong timing, lands in the wrong spot), capture it as a labeled contact sheet and read it back to see the motion. Use whenever motion correctness matters and a passing test or a single screenshot isn't enough.
---

# Contact sheet: seeing motion

You cannot see motion. A passing test and a final screenshot tell you where an element
*ends*, not how it *moved*. When the user describes something that looks wrong in motion,
turn the animation into one labeled image you can actually read, then read it.

## When to reach for this

- The user describes a motion artifact: "it snaps", "flashes", "jumps at the end",
  "stutters", "lands in the wrong spot", "the easing is off", "it pops in".
- You changed an animation and want to confirm it *looks* right, not just that the
  coordinates and the tests check out.

## The loop

1. **Get the artifact from the user.** What it looks like, on which element. You are
   confirming something they already see, not hunting blind.
2. **Make sure the animation is running** somewhere you can reach (a dev-server URL).
3. **Capture a burst** with `mcs-capture`. Clip to the moving element, and slow it down
   so the frames land on the motion:
   ```bash
   mcs-capture --url <dev-url> --clip "<css-selector>" --slowdown 6 --out /tmp/burst/
   ```
   - Slow enough that the whole animation fits the window: `count x interval` (wall-clock)
     must exceed `duration x slowdown`. Raise `--count` for long animations.
   - To trigger the animation, add `--play "<js>"`, e.g.
     `--play "document.querySelector('.open-btn').click()"`.
4. **Build the sheet:**
   ```bash
   mcs-sheet /tmp/burst/ --edges
   ```
   `--edges` catches onset/settle bugs (flash, snap). Add `--no-crop` only if the
   auto-crop zoomed in too far to see context.
5. **Read `/tmp/burst/contact-sheet.png`.** Walk the element cell by cell, and read the
   gutter time labels: a much larger delta on one cell means a pause or freeze. A freeze
   leaves no visual trace, so it shows up in the *timing*, not the picture.
6. **Fix, then re-capture and read again** to confirm the artifact is gone.

## Gotchas that will waste your time if you skip them

- **Never run the burst through a browser MCP.** A screenshot over MCP is ~300-500 ms;
  the burst needs a frame every 60-200 ms, so the cadence collapses. Use the MCP (or
  `--play`) only to *stage* the scene, then run `mcs-capture` in-process via the shell.
- **No slowdown means an unreadable sheet.** A fast transition at native speed yields two
  or three smeared frames. Always slow it.
- **Clip tightly.** A small mover on a big stage becomes a speck; clip to it.
- **Position bugs vs timing bugs.** Snaps, overshoots, and wrong landings read clearly in
  the cell positions. Pure pauses and freezes read in the timing labels. Check both.

Full flag reference is in the project README.
