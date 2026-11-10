# The list design, archived 18 Oct 2026

`psh-notch-with-list.swift` is the full client from the last build that had the list working.
It compiles: `swiftc -parse-as-library -swift-version 5 -O -o psh-notch psh-notch-with-list.swift`.

## What it contains

- **Waiting bar (always on).** 237pt wide, 32pt tall: `cutout.width + 2*(capsuleWidth + capsuleGap)`
  = 185 + 52, so it straddles the notch with 26pt either side. Dot at the left, count at the right,
  no background behind either, mirrored about the notch's centre, the count 5pt nearer the middle.
  Black, borderless, square top, bottom corners rounded 22pt, no shadow. With nothing waiting the
  bar stays and both the dot and the count are hidden: an empty full-width badge.
- **The list.** Opens on hover or on a request arriving, below the bar, never above it.
  40pt rows, at most 2 visible with the rest scrolled. Each row: risk-colour dot, name at 13pt,
  age at the right in 11pt (`now`, `Nm`, `Nh`, `Nd`, `Nw`). The last row's hover highlight uses the
  bottom-rounded notch path (`addBottomRounded`), so the highlight follows the panel's corners.
- **The request view.** Title 11pt semibold, subtitle 12pt, meta 10pt, then one row of
  deny / answer / approve (36x36) with the answer field at 14pt, single line, and a circular
  grey send button with a white arrow.
- **Modes.** compact 32pt, list 112pt (two rows), full request 196pt. The pointer opens the list;
  leaving collapses it to the badges without hiding anything; a click opens the full request.

## Why it was set aside

Animating the window's frame moved the window's top with it, so the badge at the top of the panel
drifted up and back whenever the list opened or closed. The fix, not yet applied here: one
fixed-height canvas window that cannot resize, the badge nailed to its top, and only the black
inside it morphing. `viewDidMoveToSuperview` in the archived file already pins width, height and top.
