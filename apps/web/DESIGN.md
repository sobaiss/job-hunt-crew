# Design system

The visual vocabulary for `apps/web`: a claude.ai-flavoured palette (warm
"paper" light, warm near-black dark, one coral accent) plus the type,
spacing, elevation, and motion scales built on it. Tokens live in
`app/globals.css`; this page is the usage rule, not a re-listing of values.

## Colour

Six palette tokens (`--background`, `--panel`, `--foreground`, `--muted`,
`--accent`, `--border`) plus three status tokens (`--success`, `--warning`,
`--danger`), each with a light and dark value.

- **`--accent` (coral) is for brand and primary actions only** — the
  wordmark, primary buttons, links, focus rings, active nav state. It is
  never used to colour a **Match score**, a gauge, or a status.
- **`--success` / `--warning` / `--danger` are for Match-score bands and
  status states only** ("strong"/"partial"/"weak", COMPLETED/RUNNING/FAILED).
  They do not double as decorative colour elsewhere.
- shadcn/ui primitives (`--color-card`, `--color-primary`, ...) alias onto
  these six + three — see the comment above `@theme inline` in `globals.css`
  before adding a new shadcn primitive mapping.

## Type scale

`--text-xs` through `--text-5xl`, each paired with a `--text-{name}--line-height`,
in the `@theme inline` block (drives Tailwind's `text-*` utilities):

| Token | Size | Use |
|---|---|---|
| `xs` | 12px | captions, meta |
| `sm` | 13px | secondary text, labels |
| `base` | 15px | body copy |
| `lg` | 17px | emphasised body, card titles |
| `xl` | 19px | section headers |
| `2xl` | 22px | page subheadings |
| `3xl` | 26px | page headings |
| `4xl` | 34px | hero subheadings |
| `5xl` | 52px | hero headline |

## Spacing

No new spacing tokens — Tailwind's default 4px-based `spacing-*` scale is
used as-is throughout. Prefer the existing scale steps over arbitrary
values (`p-4`, not `p-[17px]`).

## Elevation

`--shadow-xs` through `--shadow-xl` in `@theme inline` (drives Tailwind's
`shadow-*` utilities), all a soft warm-black at low opacity so they read
correctly against the paper background:

| Token | Use |
|---|---|
| `xs` / `sm` | resting cards, inputs |
| `md` | hover/raised cards |
| `lg` / `xl` | popovers, dialogs, dropdowns (matches the reviewed mockups' floating-panel shadow) |

Dark mode pairs a shadow with a visible `--border` rather than relying on
the shadow alone — a black shadow reads faintly against a dark background.

## Motion

`--ease-standard` / `--ease-emphasized` and `--duration-fast` / `-base` /
`-slow` in `@theme inline`:

- `--ease-standard` (`cubic-bezier(0.4,0,0.2,1)`) — default for most
  transitions (hover, colour, opacity).
- `--ease-emphasized` (`cubic-bezier(0.2,0,0,1)`) — entrances that should
  feel snappy (drawers, dialogs, toasts).
- `--duration-fast` (120ms) — micro-interactions (hover, focus).
- `--duration-base` (200ms) — default transitions.
- `--duration-slow` (320ms) — entrances/exits of larger surfaces (drawer,
  dialog).

These tokens are declared but not yet consumed by any component; later
slices wire them into the Sidebar drawer, dialogs, and chart entrances via
the `motion` package.
