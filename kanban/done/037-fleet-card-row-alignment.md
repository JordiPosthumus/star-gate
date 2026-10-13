# Fleet card row alignment: root cause found and fixed

Jordi's recurring complaint: the three fleet cards keep drifting out of alignment —
names wrap differently, the "2m active" pill appears on some cards only, paused
cards show footer buttons others don't — and every attempted fix "didn't take".

## Root cause (proven by reproduction, not inferred)

The card face was already the right architecture: `device()` renders the same 11
children in the same order on every card, and ui.css made each card a
`grid-template-rows: subgrid` item of `#devices{grid-template-rows:repeat(11,auto)}`
— one shared row track per section. That subgrid rule was correct and deployed,
but it was silently dead because of ONE declaration:

    .device{container:device-card / inline-size}   /* brand.css */

Container queries require containment, and containment on a subgrid item severs
track sharing: each card falls back to sizing its own implicit rows from its own
content. Verified in headless Chromium with the served CSS: with the container
declaration, three structurally different cards measured different row heights
(ACTIVITY bars at y=208/208/181); without it, all rows align exactly
(212.8/212.8/212.8). The `@container device-card (min-width:780px)` header switch
the containment existed for was already dead code (always beaten by the
higher-specificity `.device .device-top` rule).

A second, independent leak: `.device-footer:empty{display:none}` removed the
footer grid item on cards without power controls, letting Details slip up one
track relative to cards with a footer — even with subgrid working.

Why fixes "kept not taking": (1) these two rules neutralized every row-alignment
attempt; (2) the dashboard freezes its asset bundle at process start, so CSS/JS
edits only serve after a dashboard restart; (3) three generations of conflicting
`.device-top` / `.device-name-text` rules made outcomes unpredictable.

## Changes

- brand.css: drop `container:device-card / inline-size` from `.device` and delete
  the dead `@container device-card` block (with a warning comment so containment
  never returns); delete `.device-footer:empty{display:none}` and the paired
  `.device-footer:empty+.device-details{margin-top:auto}` (an empty footer must
  stay a grid item); grid columns `repeat(4,...)` →
  `repeat(auto-fit,minmax(min(330px,100%),1fr))` so three servers fill the row
  three-abreast (empty fourth track collapses to 0) and a fourth server returns
  it to four-abreast; drop the flex-era `display:flex`/`margin-top:auto` on cards
  and footers; `.device-name-text` back to single-line ellipsis (header track
  stays one line tall; full name remains in the tooltip); the engine row now
  hides fleet-wide when no card shows a media engine chip.
- ui.js: the "Nm active" duration pill moved from the mostly-empty engine row
  into the header chip row beside the request chip.
- ui.css: subgrid comment documents the containment hazard.
- dashboard.test.mjs: assertions now lock the invariants — subgrid present,
  no containment on `.device`, no `device-footer:empty{display:none}`, auto-fit
  columns; offline cards must render an EMPTY minicharts container (all 11
  children preserved) instead of no container.

Also lands the parked execution-capacity card chip and capacity-panel chip
removal from the 2026-10-12 session (same files).

## Verification

- dashboard.test.mjs 95/95 green.
- Headless-Chromium measurement of the real served CSS: every section
  (header, Serving, state pill, rates, ACTIVITY, sparklines, Thinking, footer,
  Details) at identical y across all three cards; at 1480px the fourth track
  collapses to 0px so three cards span the full content width.
- Live dashboard screenshotted after restart: rows level with real data.
- Harness kept at /tmp/card-align (repro.html, before/after PNGs).

Done: 2026-10-13 — deployed to the running dashboard (bundle rebuilt on restart).
