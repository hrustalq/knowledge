---
name: Knowledge
description: Ink on paper, graph glow — a quiet reading surface with instrument-grade controls.
colors:
  indigo-ink: "oklch(0.45 0.15 268)"
  indigo-ink-lifted: "oklch(0.74 0.11 268)"
  indigo-wash: "oklch(0.94 0.02 268)"
  indigo-wash-ink: "oklch(0.32 0.06 266)"
  warm-paper: "oklch(0.988 0.003 85)"
  paper-card: "oklch(1 0 0)"
  paper-tint: "oklch(0.955 0.006 85)"
  sidebar-paper: "oklch(0.966 0.005 85)"
  ink: "oklch(0.22 0.02 265)"
  ink-muted: "oklch(0.5 0.02 262)"
  rule: "oklch(0.905 0.008 85)"
  night-ground: "oklch(0.165 0.012 265)"
  signal-red: "oklch(0.577 0.245 27.325)"
  panel-note: "oklch(0.55 0.13 250)"
  panel-tip: "oklch(0.55 0.13 155)"
  panel-important: "oklch(0.52 0.14 300)"
  panel-warning: "oklch(0.62 0.13 75)"
  panel-caution: "oklch(0.56 0.17 25)"
  pin-open: "oklch(0.79 0.14 72)"
  pin-open-ink: "oklch(0.26 0.06 72)"
  pin-done: "oklch(0.77 0.13 155)"
  pin-done-ink: "oklch(0.24 0.05 155)"
  draw-ink: "oklch(0.32 0.02 265)"
  draw-blue: "oklch(0.52 0.15 255)"
  draw-green: "oklch(0.52 0.13 155)"
  draw-amber: "oklch(0.63 0.14 70)"
  draw-red: "oklch(0.55 0.18 25)"
  draw-violet: "oklch(0.5 0.16 295)"
typography:
  display:
    fontFamily: "Sora, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Sora, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Sora, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.015em"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.2
  code:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.86em"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  full: "999px"
spacing:
  block: "1.5rem"
  block-nested: "0.85rem"
  gutter: "1rem"
  gutter-wide: "2rem"
  measure: "46rem"
  rail: "16rem"
  topbar: "3.5rem"
components:
  button-primary:
    backgroundColor: "{colors.indigo-ink}"
    textColor: "{colors.warm-paper}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "oklch(0.45 0.15 268 / 0.9)"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
  button-ghost-hover:
    backgroundColor: "{colors.indigo-wash}"
    textColor: "{colors.indigo-wash-ink}"
  button-outline:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 1rem"
    height: "2.25rem"
  input-text:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.25rem 0.75rem"
    height: "2.25rem"
  card-surface:
    backgroundColor: "{colors.paper-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
  badge-default:
    backgroundColor: "{colors.indigo-ink}"
    textColor: "{colors.warm-paper}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.5rem"
    typography: "{typography.label}"
  nav-item-active:
    backgroundColor: "oklch(0.45 0.15 268 / 0.1)"
    textColor: "{colors.indigo-ink}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.625rem"
  comment-pin-open:
    backgroundColor: "{colors.pin-open}"
    textColor: "{colors.pin-open-ink}"
    rounded: "{rounded.full}"
    padding: "0 0.28rem"
    height: "1.3rem"
  comment-pin-resolved:
    backgroundColor: "{colors.pin-done}"
    textColor: "{colors.pin-done-ink}"
    rounded: "{rounded.full}"
    height: "1.3rem"
---

# Design System: Knowledge

## Overview

**Creative North Star: "Ink on Paper, Graph Glow"**

The phrase is not aspirational — it is already written at the top of `style.css`,
and the system has been obeying it. The ground is paper that was never bleached
white (a warm near-white at hue 85°), the type is ink pressed into it, and exactly
one cool indigo is allowed to glow: on links, on the active trail, on a focus ring,
on the root node of a graph. Everything that glows is _structure_. Nothing glows
because it wanted attention.

The register is quiet, precise and unhurried at the level of the page, and
instrument-grade at the level of the control. Those are not in tension: the page
recedes so that a passage of prose is the loudest thing on screen, while every
control that frames it — a 36px button, a 6px status dot, a hairline rule under an
h2, a comment pin sized in rem so it stays legible in any prose — is exact,
compact and unambiguous. This is a surface people read for an hour and then annotate
in the margin. Chrome that competes with the text is a defect, and a control that
leaves you guessing its state is also a defect.

Depth is nearly absent by design. Surfaces separate by hairline border and tonal
shift, not by shadow; a shadow means the element has genuinely left the page. Color
is rationed the same way: five semantic panel hues and six diagram hues exist, and
emerald/amber/red are spoken for by the indexing lifecycle and may not be borrowed.
Confirmed anti-references: the generic AI-SaaS gradient deck (no gradient heroes, no
glassmorphism, no glowing orbs — the AI here is an assistant, not the aesthetic),
enterprise wiki beige (no washed-out grey chrome, no cramped uniform 14px), and the
Notion clone (no emoji-as-identity, no rounded-everything, no playful illustration
empty states — this product is governed and technical).

**Key Characteristics:**

- Warm paper ground, indigo ink, one accent that only ever marks structure.
- Flat by default; hairline borders and tonal steps carry all separation.
- One stylesheet serves both reading and writing — they are pixel-identical.
- Status is a 6px dot, not a banner.
- Every color token is declared twice, light and dark, with no exceptions.
- Identity is derived, never uploaded: initials on a hue hashed from the user id.

## Colors

A two-temperature palette: warm neutrals (hue 85°) for every ground, cool indigo
(hue 265–268°) for every ink and the single accent. The warmth is subtle — chroma
0.003–0.008 — but it is what keeps the page from reading as a spreadsheet.

### Primary

- **Indigo Ink** — the only accent. It appears on links in prose, the active nav
  row (at 10% over the sidebar), focus rings, the graph's root node, `::selection`
  at 20%, and the blockquote rule at 45%. It never fills a decorative surface.
  In dark mode the token is re-declared lighter (**Indigo Ink Lifted**) so it stays
  an accent against a near-black ground rather than disappearing into it.
- **Indigo Wash** — the accent diluted to a hover/active surface tint, paired with
  its own darker ink for text that sits on it.

### Neutral

- **Warm Paper** — the page ground. Not white; the hue-85° warmth is the whole
  "paper" half of the north star.
- **Paper Card** — pure white, used only where a surface must lift off the ground:
  cards, popovers, dialogs. The card being _whiter_ than the page is the inversion
  that replaces a shadow.
- **Paper Tint** — the secondary/muted surface: input wells, inactive chips, the
  search trigger's field.
- **Sidebar Paper** — the navigation rail, one step darker than the page so the rail
  reads as a different material without needing a heavier border.
- **Ink** — body and heading text.
- **Ink Muted** — secondary text, captions, icon defaults, h4, blockquote body.
- **Rule** — every border and input stroke in the system. One value, one weight.
- **Night Ground** — the dark theme's page. Blue-charcoal, not neutral grey; the
  dark mode is the same two temperatures inverted, not a separate palette.

### Tertiary

- **The panel ramp** — five semantic hues for callouts, mapped to GitHub's alert
  vocabulary: note (blue), tip (green), important (violet), warning (amber),
  caution (red). Each drives a callout's left rule, its masked glyph, and its dot
  in the panel switcher. These are the _only_ semantic colors in prose.
- **The diagram ramp** — six hues (ink, blue, green, amber, red, violet) reserved
  for drawn diagrams, plus a display-font token so diagram labels match headings.
  Lifted wholesale in dark mode.
- **Pin Open / Pin Done** — the comment pin's fill, amber while a thread is open,
  green once resolved, each shipped with its own paired ink.

### Signal

- **Signal Red** — destructive actions only.
- Emerald / amber / red at Tailwind's 500 step carry the indexing lifecycle dot:
  emerald = indexed, amber (pulsing) = indexing or finalized, red = failed, muted at
  40% = draft.

### Named Rules

**The Two Grounds Rule.** Every color token is declared twice — once in `:root`, once
in `.dark`. A token that exists in only one theme is a bug, not a light-mode
optimization. The two exceptions are deliberate and documented in the CSS: the
comment pin's fill and ink travel as a fixed pair, because a pin whose ink follows
the theme while its fill does not is unreadable in one of the two.

**The One Indigo Rule.** The accent marks structure and nothing else — link, active
trail, focus, selection, graph root. It is never a background for a hero, a card, or
a section. Its rarity is what makes the active row findable.

**The Reserved Signal Rule.** Emerald, amber and red belong to the indexing
lifecycle. Do not borrow them for emphasis, decoration, or a second meaning of
"good". If a new state needs a color, take it from the panel ramp.

## Typography

**Display Font:** Sora (600, 700), with `ui-sans-serif, system-ui, sans-serif`
**Body Font:** the system sans stack (`ui-sans-serif, system-ui, sans-serif`)
**Code Font:** `ui-monospace, SFMono-Regular, monospace`

**Character:** Sora is geometric, slightly technical, and tightened by -0.015em
tracking at every heading size — it reads as drafted rather than typeset. Against it,
the system stack for body copy is deliberately anonymous: the prose is somebody's
technical writing, and the type's job is to disappear at a 1.7 line-height for as
long as they keep reading.

### Hierarchy

- **Display** (Sora 700, 1.75rem, -0.015em): page and document h1.
- **Headline** (Sora ~650, 1.35rem, hairline rule beneath): document h2. The rule
  under an h2 is the only decorative line in prose, and it is what makes a long
  page skimmable.
- **Title** (Sora ~620, 1.12rem): h3.
- **Subtitle** (Sora ~620, 1rem, in Ink Muted): h4 — the one heading level that
  steps _down_ in color rather than up in size.
- **Body** (system sans, 0.95rem, 1.7): all prose, capped at a 46rem measure.
- **Label** (system sans, 0.75rem, 500): chips, metadata, rail previews, kbd hints.
- **Code** (mono, 0.86em, ligatures disabled inline): inline code sits on an 8%
  current-color wash; blocks sit on a 5% foreground-over-card panel with a rule.

### Named Rules

**The One Surface Rule.** Reading and writing share a single stylesheet. A panel, a
table, a diagram or a code block must be pixel-identical whether the page is being
read or edited. Any type rule that applies to only one of the two is a bug —
"it looked different once I saved" is precisely what the shared sheet exists to
prevent.

**The Display-Is-Structure Rule.** Sora is for headings and diagram labels. It never
sets body copy, button text, or UI labels.

**The Loaded-Weight Rule.** Only the weights actually requested from the font
provider may be specified. The stylesheet currently asks for 650 and 620 while
loading 600 and 700, so those headings silently snap to a neighbour — either widen
the font request or move to the loaded steps; do not add more phantom weights.

## Layout

A three-zone shell at desktop: a 16rem navigation rail, a 3.5rem sticky topbar
(translucent at 90% with a backdrop blur), and a scrolling content column padded
1rem / 1.5rem, opening to 2rem at `lg`. The rail is Confluence-shaped — brand,
scope switcher, primary nav, then a Projects → Pages navigation stack.

`lg` (1024px) is the shell's one real hinge: above it the rail is a persistent,
collapsible column; below it the same component becomes an off-canvas drawer over a
40% black scrim. `sm` handles content-level reflow (avatar clusters, kbd hints,
table columns). `md`, `xl` and `2xl` are used only incidentally — this is a
two-breakpoint system in practice, and new work should stay inside it.

Prose is capped at a 46rem measure and centred; the page rail of collapsible widgets
lives _outside_ that measure, never inside it. Vertical rhythm in documents is a
single block gap of 1.5rem, dropping to 0.85rem for blocks nested inside a panel,
column or expand — so a callout does not inherit page-level air and inflate.

Rail widgets cap at 26rem tall (32rem at `lg`) and scroll in both directions, so a
panel authored for a full-width page stays inside its card instead of spilling.

### Named Rules

**The Measure Rule.** Prose never exceeds 46rem. Anything that wants the full column
— a revision table, a diff, a graph — is not prose and belongs in a rail widget or a
maximized dialog.

**The Two Modes Rule.** A route is either a _document_ (the content column grows,
`<main>` scrolls, chrome padding applies) or a _fill surface_ (the route owns the
viewport and scrolls something inside itself — the editor, the chat, the import
wizard). Never both, and never a fill surface that also pushes the page taller.

## Elevation & Depth

Flat by default. Separation comes from a 1px rule and a tonal step — sidebar darker
than page, card whiter than page — and this carries almost the entire interface.
Shadows are a statement that an element has physically left the page, and there are
only three tiers in use.

### Shadow Vocabulary

- **Seated** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)` — Tailwind `shadow-xs`):
  form controls only, inputs and select triggers. Barely perceptible; it exists to
  keep a transparent-backgrounded input from dissolving into the page.
- **Resting** (`shadow-sm`): cards that carry their own content region.
- **Floating** (`box-shadow: 0 16px 48px -12px` at 20% foreground, 60% black in
  dark): dialogs, sheets and the mobile drawer. Long, soft, heavily negative-spread
  — the shape of something well above the page rather than lifted off it.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. A shadow means the element
is floating above the document — a dialog, a popover, a dropdown, a drawer. If it
scrolls with the page, it gets a border, not a shadow.

## Shapes

One radius scale derived from a 10px root: **6px** (sm — nested chips, small
toggles), **8px** (md — the default for every control: buttons, inputs, nav rows,
menu items), **10px** (lg — rail widgets, code blocks), **14px** (xl — cards and
dialogs), and **999px** (full — badges, avatars, comment pins, status dots).

The form language is rectangular and calm: hairline 1px borders at a single weight
and a single color token, no double rules, no outlines used as decoration. The one
place the system draws a different silhouette is the graph, and it is semantic
there — documents are round-rectangles 32px tall sized to their label, entities are
14px circles with the label set below them. Shape is how you tell a page from a
thing a page mentions.

### Named Rules

**The Hairline Rule.** Borders are 1px, one color token, everywhere. Weight is never
used for emphasis; if a boundary needs to be stronger, change the tone on either
side of it.

**The Round Means Count Rule.** Fully-round shapes are reserved for things that
represent a quantity or an identity — badges, avatars, comment pins, status dots.
Controls are never pill-shaped.

## Components

### Buttons

- **Shape:** softly squared (8px), 4 heights — 24 / 32 / 36 / 40px — plus matching
  square icon sizes. Icons auto-size to 16px (12px at xs) and horizontal padding
  tightens when a button is icon-led.
- **Primary:** Indigo Ink on paper-white text, hover to 90% opacity.
- **Ghost / Outline / Secondary:** ghost is transparent until hover, when it takes
  the Indigo Wash surface; outline adds the hairline and a _Seated_ shadow.
- **Focus:** a 3px ring at 50% of the ring token plus a border shift — never an
  outline-only or color-only cue.
- **Invalid:** `aria-invalid` drives a destructive-tinted ring, so validation state
  is a real attribute, not a class.

### Inputs / Fields

- **Style:** transparent well, hairline border, 8px radius, 36px tall, _Seated_
  shadow. In dark mode the well fills to 30% of the input token instead.
- **Focus:** the same 3px ring + border shift as buttons. Transitions run on
  `color, box-shadow` only, never on layout.
- **Disabled:** 50% opacity with pointer events off.

### Cards / Containers

- **Corner Style:** 14px.
- **Background:** Paper Card, one step whiter than the page.
- **Shadow:** _Resting_ only; the hairline does the real work.
- **Internal Padding:** 1.5rem, with a 1.5rem internal gap between regions.

### Badges / Chips

- Fully round, 0.75rem label type, 2px/8px padding, transparent border on filled
  variants so filled and outline chips share one silhouette.

### Navigation

- **Rail rows:** 8px radius, 14px label, icon at 16px. Inactive rows are
  sidebar-foreground at 80% and take the sidebar accent on hover; the active row is
  Indigo Ink text on the accent at 10% — a tint, never a solid fill.
- **Tree:** each level indents 13px and hangs a hairline rail from the parent, so
  the page tree literally draws as a graph. A node with children gets a disclosure
  chevron; a leaf gets a status dot in the same 20px slot, so rows never jitter.
- **Panes:** moving deeper animates a push — the incoming pane travels 100% from the
  right while the outgoing one recedes only 14% at 55% opacity. The unequal travel
  is the entire effect: equal travel reads as a carousel, unequal reads as depth.
  280ms on `cubic-bezier(0.32, 0.72, 0, 1)`, identical in both directions, with the
  returning parent relighting over the first 110ms. Under `prefers-reduced-motion`
  the depth cue is dropped for a 120ms linear crossfade — the swap still has to be
  perceptible.

### Status Dot (signature)

A 6px circle carrying a revision's whole lifecycle: emerald = indexed, amber and
_pulsing_ = indexing or finalized, red = failed, 40% muted = draft. It appears in
the tree, in lists, and beside titles. Motion is the tell for "work in progress" —
the pulse is the only animation in the system that runs at rest, and it is
information, not decoration.

### Comment Anchor & Pin (signature)

An annotated passage is highlighted at 26% of the warning hue with a 55% inset
underline — it reads as highlighter over the text, never as a replaced background.
Hovering deepens it to 42%. A resolved thread drops to a 16% green wash: still
visible, no longer competing. Each passage carries one superscript pin — a 1.3rem
stadium in Pin Open amber (Pin Done green when resolved) holding the comment count,
optionally preceded by overlapping participant faces, each ringed in the pin's own
fill so the overlap reads as depth. The pin is sized in `rem`, not `em`, so it stays
legible in whatever prose it lands in.

Two renderers draw this — `<mark>` elements in review mode, ProseMirror decorations
on the page — and they must be visually identical.

### Rail Widget (signature)

A collapsible card in the page rail. Collapsed, it is one scannable row: chevron,
icon, title, and the single fact that decides whether to open it (`#2`, `1 field`,
`45 relations`, `4m ago`). Open, it gains a hairline top rule and its body mounts —
only while open, because some bodies are expensive. Expandable widgets show a
maximize control that lifts the same content into a dialog.

### Callout Panel (signature)

A left-ruled block in one of five semantic hues, with a masked-SVG glyph in the
accent color and body copy on the page ground. The panel switcher exposes the five
as colored dots. Inside a panel, block rhythm drops to the nested 0.85rem gap and
first/last children lose their outer margins, so a callout never pushes against its
own border.

### User Avatar (signature)

Initials on a hue hashed deterministically from the _user id_ — never the display
name, because the name can change and identity cannot. The hue is shared by two
renderers (the Vue component and the DOM-built comment pin), with a deeper 30%
lightness variant for faces small enough that white initials would fail contrast.
An AI-authored item swaps the initials for a bot glyph on the important-panel violet:
the assistant posts under the identity of whoever ran it, and without the glyph a
machine finding would wear a colleague's face.

### Named Rules

**The Pin Carries Its Own Ink Rule.** The comment pin's fill and ink are a fixed
pair, theme-independent. Anything that sits on a tinted highlight rather than on the
page must carry both halves of its contrast.

**The Derived Identity Rule.** There is no avatar storage. Identity marks are
computed from the user id, and machine authorship is always visually distinct from
human authorship.

## Do's and Don'ts

### Do:

- **Do** keep the accent for structure — link, active trail, focus ring, graph root,
  selection. If a new element wants Indigo Ink, ask what structure it marks.
- **Do** declare every new color token in both `:root` and `.dark`, in the same
  order, in the same file.
- **Do** separate surfaces with the 1px rule token and a tonal step. Reach for a
  shadow only when the element genuinely floats.
- **Do** express prose in the shared stylesheet so the reader and the editor stay
  pixel-identical.
- **Do** cap prose at the 46rem measure and put anything wider in a rail widget or a
  maximized dialog.
- **Do** pair every motion with a `prefers-reduced-motion` branch that keeps the
  change perceptible — a 120ms crossfade, not a jump cut.
- **Do** give focus a 3px ring plus a border shift, and drive validity from
  `aria-invalid` rather than a class.
- **Do** size annotation affordances in `rem` so they survive whatever prose scale
  they land in.

### Don't:

- **Don't** introduce a gradient background, a glassmorphic card, or a glowing orb.
  The AI is a capability here, not a look.
- **Don't** borrow emerald, amber or red for emphasis — they are the indexing
  lifecycle's, and a second meaning makes the dot unreadable.
- **Don't** add a resting shadow to anything that scrolls with the page.
- **Don't** set body copy, buttons or UI labels in Sora.
- **Don't** specify a font weight the stylesheet does not actually load.
- **Don't** animate anything at rest except the amber indexing pulse; that motion is
  information, and a second moving thing dilutes it.
- **Don't** use a fully-round radius on a control. Round means a count or an
  identity.
- **Don't** put a status, count or relation behind a tab when a collapsed rail row
  could show it — the rail is a stack precisely so three answers aren't hidden
  behind a click.
- **Don't** let a machine-authored item render with a person's initials.
- **Don't** reach for `md:`, `xl:` or `2xl:` for new layout work; this shell hinges
  at `lg` and reflows content at `sm`.
