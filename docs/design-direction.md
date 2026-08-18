# Race Lens — visual direction

One job: a runner finds themselves among thousands of photos, in about ten
seconds. Everything below serves that and nothing else.

## Thesis

**The bib is the interface, and the album is a timeline.**

Two artifacts from the sport's own world, neither of which the old UI used:

1. A race bib is a *physical object* — a numbered rectangle with a printed
   header band, pinned on with safety pins. So the primary search control is not
   a text field with a magnifying glass. It is the number, set at bib scale, in
   bib proportions. You are claiming the number you wore.
2. Every photo carries `taken_at` — the wall-clock minute it was shot. The old UI
   spent that on a caption. It is the only structure the content actually has, so
   results are grouped by clock time: 06:41, 07:12, 07:58. A runner recognises
   their race by when it happened, not by a scroll position.

Numbering, eyebrows and dividers elsewhere would be decoration. Time is the one
sequence that is real here, so it is the only one used structurally.

## Palette

Named for what they are, not for a scale.

| token | hex | why |
| --- | --- | --- |
| `--ink` | `#07090c` | Near-black ground. Photos supply all the colour; the frame supplies none. |
| `--surface` | `#101419` | Cards and rails, one step up from the ground. |
| `--line` | `#1e242c` | Hairlines. Visible, never structural. |
| `--paper` | `#eef1f4` | Text. Slightly cool white, the colour of a printed bib. |
| `--split` | `#38e1c8` | THE accent. Nothing else is coloured. |
| `--pin` | `#ff6b6b` | Destructive only. |

`--split` is a timing-clock green-cyan — the colour of a finish-line display,
and the one hue these photographs do not contain. Cambodian race kit runs hot
orange and pink; dawn light is warm; the old accent had already been moved off
orange for exactly this reason, measured against real frames. Amber would be the
obvious "timing" choice and is the one colour that would disappear into the kit.

## Type

- **Archivo** — numerals and display. A squared grotesque with tabular figures.
  Race bibs are printed in bold condensed grotesques; this is that voice without
  being a costume. Used for bib numbers, clock times and headings only.
- **Geist** — body and UI. Quiet, already in the stack, does not compete.
- Tabular figures everywhere a number can change: a clock that shifts width while
  you read it is a clock you stop trusting.

## Layout

Public side is photo-forward and edge-to-edge — the frame gets out of the way.
Operator side is a left rail with quiet rows, in the register of Vercel and
Railway: status as small coloured text, not badges.

```
PUBLIC — album                          OPERATOR — event
┌──────────────────────────────┐        ┌────┬─────────────────────────┐
│  [ 0 0 4 6 ]  ← bib, at size │        │ ▮  │ Coverage    1,070 / 1,070│
│  or use your face            │        │ ▮  │ Bibs        617 photos   │
├──────────────────────────────┤        │ ▮  ├─────────────────────────┤
│ 06:41 ─────────────────────  │        │ ▮  │ link · 665 · complete   │
│ ▦ ▦ ▦ ▦ ▦                    │        │    │ link · 405 · complete   │
│ 07:12 ─────────────────────  │        │    │                         │
│ ▦ ▦ ▦                        │        │    │ [ Re-read bib numbers ] │
└──────────────────────────────┘        └────┴─────────────────────────┘
```

## Signature

The bib. A runner types their number and it sets itself in a real bib —
header band, pinned corners, tabular numerals — then that bib becomes the
result header. It is the one loud element; everything else stays quiet.

## The viewer

Tapping a photo opens it in place. It used to open the original in a new tab,
which on a phone means leaving the album and losing your place in a 1,070-photo
wall — for the action a runner performs most once they have found themselves. The
arrangement is the one every photo viewer has had since Lightroom (close left,
counter centred, original right), because nobody should have to learn it. The
caption is the minute the shutter fired, so the timeline reaches the viewer too.

Reference: Airbnb's viewer for the frame, Air's for the top bar.
https://mobbin.com/screens/c8e7fcb1-907f-4b06-b49a-c6c337c59cd9
https://mobbin.com/screens/acf23fac-6846-4486-870b-37908a41746b

## Motion

Sparse, and decided by frequency rather than taste.

- **Opening the viewer** is occasional, so it animates: 200ms, ease-out on a real
  curve, scaling from 0.96 — nothing in the world appears from nothing. Closing is
  faster, because the reader has already decided.
- **Stepping between photos does not animate.** The arrows are pressed
  repeatedly, and animating a repeated action puts a delay between the hand and
  the picture.
- **Pressing anything** scales to 0.97 for 160ms. It is the cheapest way to make
  an interface feel like it is listening.
- **Hover growth on tiles** is gated behind `(hover: hover) and (pointer: fine)`,
  or a tap on a phone leaves a tile stuck slightly enlarged.
- Only `transform` and `opacity` are animated, so none of it touches layout.
- `prefers-reduced-motion` keeps the fades and drops every movement — fewer and
  gentler, not zero.
