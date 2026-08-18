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

## Motion

One orchestrated moment: the bib fills as you type and settles once. Time
groups fade in on scroll. Nothing else animates. `prefers-reduced-motion`
removes all of it.
