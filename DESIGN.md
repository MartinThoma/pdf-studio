---
name: PDF Studio
description: Rearrange, rotate, mark and edit PDF pages in the browser; files never leave the device.
colors:
  bg: "#f4f3ef"
  surface: "#ffffff"
  surface-2: "#ecebe6"
  text: "#1d1d1b"
  muted: "#6c6b65"
  border: "#dedcd5"
  accent: "#2847c4"
  accent-hover: "#1f3aa6"
  accent-soft: "#e3e8fb"
  accent-ink: "#ffffff"
  danger: "#b4302a"
  danger-soft: "#f8e4e2"
  danger-ink: "#ffffff"
  private: "#f03c64"
  private-strong: "#d92b57"
  private-ink: "#ffffff"
  highlight: "#e8b800"
  highlight-ink: "#2b2300"
  removed: "#55524a"
  update: "#e0780a"
  warning-soft: "#fdecc8"
  warning-ink: "#7a4b00"
  toast-bg: "#1e1e1c"
  toast-ink: "#f2f1ec"
  paper: "#ffffff"
  paper-skeleton: "#e9e8e3"
  paper-muted: "#8a8982"
  paper-accent: "#2847c4"
  paper-danger: "#b4302a"
  paper-private-edge: "rgb(200 20 70 / 0.8)"
  bg-dark: "#181816"
  surface-dark: "#242422"
  surface-2-dark: "#2e2d2a"
  text-dark: "#ecebe5"
  muted-dark: "#a09f97"
  border-dark: "#3a3935"
  accent-dark: "#7f97ff"
  accent-hover-dark: "#9aadff"
  accent-soft-dark: "#2a3256"
  accent-ink-dark: "#10142a"
  danger-dark: "#f08b82"
  danger-soft-dark: "#4a2522"
  danger-ink-dark: "#2b0f0c"
  warning-soft-dark: "#4a3a14"
  warning-ink-dark: "#ffd98a"
  toast-bg-dark: "#f2f1ec"
  toast-ink-dark: "#1e1e1c"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1
  label-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  caption:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
    fontFeature: "tnum"
  badge:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.4
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  hairline: "1px"
  paper: "2px"
  key: "5px"
  sm: "6px"
  inner: "7px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  overlay: "16px"
  dropzone: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  bar: "60px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "38px"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
  button-small:
    typography: "{typography.label-small}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-large:
    rounded: "{rounded.md}"
    padding: "0 22px"
    height: "46px"
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "36px"
  view-switch-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
  selection-count:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  page-card:
    rounded: "{rounded.lg}"
    padding: "8px 8px 6px"
  page-card-selected:
    backgroundColor: "{colors.accent-soft}"
  menu:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "5px"
  toast:
    backgroundColor: "{colors.toast-bg}"
    textColor: "{colors.toast-ink}"
    rounded: "{rounded.lg}"
    padding: "10px 10px 10px 16px"
  toast-error:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-ink}"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "8px 20px 20px"
---

# Design System: PDF Studio

## Overview

**Creative North Star: "The Paper Desk"**

PDF Studio is a calm, warm desk with paper on it. The desk (the background and every bar and
panel) is flat, warm off-white and stays out of the way; the pages are white sheets with a soft
shadow, the only things on screen with weight. Tools sit at the edges of the desk: a top bar, a
context bar under it, and in the Details view a strip on the left and a panel on the right. The
middle belongs to the pages.

The mood is calm, plain and paper-first. One blue accent, Ballpoint Blue, marks everything you
can act on or have selected. Every other colour carries a fixed meaning (danger, privacy,
highlight, which file a page comes from) and never decorates. Type is the system font at small,
dense sizes, as in a native app. Motion is short and quiet: things settle into place, they
don't perform.

Light and dark mode follow the system setting. In dark mode the desk turns to Night Desk; the
pages stay white, because they are paper.

**Key Characteristics:**
- Flat warm chrome, white paper with the only real shadow.
- One interactive accent (Ballpoint Blue); all other hues are meanings.
- System font, small sizes (12–17px), tabular numbers for anything counted.
- Thin 1px borders and 8–10px corners; states shown by tint, not by weight.
- Short ease-out motion (120–260ms), switched off under reduced motion.

## Colors

Warm, low-contrast neutrals with a single saturated blue for interaction, plus a small set of
signal colours that each mean one thing.

### Primary
- **Ballpoint Blue** (`accent`): primary button (*Download*, *Choose PDF files*), selected page
  outline and check, the active tool, focus rings, drop marker while dragging, the logo and the
  empty-state icons. Its hover is a deeper Ballpoint (`accent-hover`). In dark mode it lightens to
  a periwinkle (`accent-dark`) with dark ink on it (`accent-ink-dark`).
- **Blue Wash** (`accent-soft`): the tinted background of selected things: selected page card,
  active view-switch button, current strip item, the selection count pill, the "works offline"
  status.

### Neutral
- **Desk** (`bg`) / **Night Desk** (`bg-dark`): the page background and, at 88–90% opacity with a
  12px blur, the sticky bars.
- **Card White** (`surface`): buttons, inputs, menus, dialogs, the dropzone, the mark list rows.
- **Pressed Desk** (`surface-2`): hover on buttons, menu items and strip items.
- **Ink** (`text`): all primary text. **Pencil** (`muted`): secondary text, captions, field
  labels, hints, the file name under a page.
- **Rule Line** (`border`): every 1px border and divider.
- **Toast Ink / Toast Paper** (`toast-bg`, `toast-ink`): toasts are dark on the light desk and
  light on the dark desk.

### On paper
The PDF page is white in both modes, so everything drawn on it has its own tokens that do not
change in dark mode.
- **Paper** (`paper`): the page in the grid, strip, stage and drag ghost.
- **Paper Skeleton / Paper Pencil** (`paper-skeleton`, `paper-muted`): the placeholder lines
  while a preview loads, and "No preview".
- **Ballpoint on Paper** (`paper-accent`): the frame under the pointer, the selected objects, the
  rectangle being dragged, the ring around the current mark. Equal to light-mode Ballpoint Blue in
  both modes; the dark-mode periwinkle would be too faint on white.
- **Danger on Paper** (`paper-danger`): the delete dot on a mark.
- **Privacy Edge** (`paper-private-edge`): the thin crimson edge of a private mark.

### Signal colours (meaning only)
- **Danger Red** (`danger`, `danger-soft`, `danger-ink`): delete actions (red text, red-wash
  hover), error toasts, invalid inputs. In dark mode the red is light, so text on it is dark.
- **Privacy Pink** (`private`, `private-strong`, `private-ink`): private marks (a 38% fill on the
  page), their page badge, strip dot and list edge; the stronger crimson for the active *Mark
  private* tool and the rectangle being dragged.
- **Highlighter Yellow** (`highlight`, `highlight-ink`): the highlight badge and strip dot, and the
  edge of a highlight in the mark list. Highlights on the page use the five highlight colours from
  `src/annotations.js` (yellow, green, blue, purple, orange) at 50% opacity, multiplied onto the
  paper.
- **Removed Grey** (`removed`): the badge on a page with deleted objects.
- **Source dots**: each opened file gets a colour from `SOURCE_COLORS` in `src/app.js` (blue,
  orange, green, magenta, teal, amber, rose, olive), shown as an 8px dot before the file name.
- **Update Orange** (`update`): the dot on the *Update* button. **Warning Amber** (`warning-soft`,
  `warning-ink`) for the "newer version" status.

### Named Rules
**The One Ink Rule.** Ballpoint Blue is the only colour that means "you can act on this" or "this
is selected". A new interactive state uses it; it never gets a second accent.

**The Meaning-Only Rule.** Red, pink, yellow, orange and the source colours each mean exactly one
thing. Never use them for decoration, illustration or emphasis.

**The White Paper Rule.** The PDF page is always pure white with its paper shadow, in light and dark
mode. Dark mode darkens the desk, never the paper.

**The On-Paper Rule.** Anything drawn on top of the page uses the `paper-*` tokens, never the
desk tokens (`accent`, `danger`, `muted`), because the desk tokens change in dark mode and the
paper doesn't.

## Typography

**Display Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)
**Body Font:** the same stack
**Label/Mono Font:** ui-monospace (SFMono-Regular, Menlo, Consolas), only for PDF source in the
developer options

**Character:** the platform's own UI font, so the app feels like an installed tool and loads
nothing extra. Hierarchy comes from weight (400, 500, 600, 650, 700) more than from size.

### Hierarchy
- **Display** (700, 22px, 1.25, −0.015em): the empty-state heading only.
- **Headline** (700, 17px): dialog titles.
- **Title** (650, 16px, −0.01em): the *PDF Studio* wordmark. Panel headings ("Selected",
  "Marks on this page") are 14px.
- **Body** (400, 15px, 1.45): base text, dialogs, toasts at 14px.
- **Label** (500, 14px, 1): buttons, menu items, toasts.
- **Label small** (500, 13px, 1): small buttons, field labels, hints, the selection count, page
  captions.
- **Caption** (650, 12px, tabular numbers): panel field labels and the strip's page numbers; at
  400 for file names under pages and comments in the mark list.
- **Badge** (650, 11px, tabular numbers): rotation and mark badges on thumbnails, mark kinds.

### Named Rules
**The System Font Rule.** No web fonts. The app must work offline and under a CSP that blocks
other origins, and it should look native on every platform.

**The Counted Numbers Rule.** Every number that counts or changes (page numbers, rotation, counts,
the page field, version) uses tabular figures.

## Layout

- **Bars:** a sticky top bar (60px) with the wordmark left and actions right, and a sticky
  context bar under it (at least 52px, wraps on small screens) with the view switch, a summary or
  the selection actions, and view controls on the right. Both bars are translucent Desk with a
  12px backdrop blur and a 1px Rule Line underneath. Side padding is 16px or the safe-area inset,
  whichever is larger.
- **Arrange view:** an auto-filling grid of page cards, each column at least `--thumb` wide
  (168px by default; a slider changes it; 132px under 720px). Gaps are 22px vertical, 18px
  horizontal (14/10 on phones). 96px of space at the bottom keeps the last row clear of toasts.
- **Details view:** three columns: a 112px strip of pages, the page stage, and a 280px panel. The
  strip and panel are sticky under the bars and scroll on their own. Under 1000px the strip
  disappears and the panel moves below the stage.
- **Empty state:** one dropzone card, at most 560px wide, centred in the free space.
- **Small screens (≤720px):** secondary buttons in the bars become 36px icon-only buttons (their
  label stays for screen readers); *Download* keeps its label. The shortcuts button and the size
  slider are hidden.
- **Spacing rhythm:** 4 / 6 / 8 / 12 / 16 / 22px. Gaps between buttons in a bar are 6px; groups are
  separated by a 1px × 24px divider.

### Named Rules
**The Square Slot Rule.** Every thumbnail sits centred in a square slot, sized so the page fits in
any rotation. Rotating a page turns it in place and never reflows the grid.

## Elevation & Depth

The desk is flat. Bars, panels, buttons, inputs and the dropzone have no shadow; they are
separated by 1px Rule Lines and by tint (Desk, Card White, Pressed Desk). Depth exists only for the
paper and for things that float above the desk for a moment.

### Shadow Vocabulary
- **Paper** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.12), 0 4px 14px rgb(0 0 0 / 0.07)`; dark mode
  0.5 / 0.35): every PDF page: thumbnails, strip, stage, drag ghost image.
- **Hover tools** (`0 2px 10px rgb(0 0 0 / 0.18)`): the rotate/delete bar that appears on a page
  card.
- **Badge** (`0 1px 4px rgb(0 0 0 / 0.18)`): rotation badge, strip delete button, mark delete dot.
- **Menu / toast** (`0 8px 28px rgb(0 0 0 / 0.22–0.25)`): context menus, the download panel,
  toasts.
- **Lifted** (`0 12px 32px rgb(0 0 0 / 0.25)`): the drag ghost card; the drop overlay card uses
  `0 12px 40px rgb(0 0 0 / 0.2)`.
- **Dialog** (`0 24px 64px rgb(0 0 0 / 0.3)`) over a 35% black backdrop.

### Named Rules
**The Only Paper Lifts Rule.** Only paper and floating layers (menus, toasts, dialogs, the drag
ghost, hover tools) cast shadows. Never add a shadow to a bar, panel, card or button at rest.

## Shapes

Soft but not round. Controls use gently curved corners (8px); containers that hold several things
use 10px; dialogs 14px; the drop overlay card 16px; the dropzone 18px. Controls nested inside a
floating container are a step tighter: 7px for the buttons in a toast or the page hover bar, 6px
for menu items and side-panel inputs. Keyboard keys are 5px. Pages are almost square-cornered
(2px) because they are paper; the frame of a selected object is 1px. Counts and badges are pills. Borders are always 1px Rule Line, except the dashed 2px
dropzone border and the dashed accent frame that shows what a click will select.

## Components

### Buttons
Quiet and precise: a thin border, small medium-weight label, an icon before the label.
- **Shape:** gently curved (8px), 38px high; small 32px, large 46px; icon-only buttons are square.
- **Default:** Card White with a Rule Line border and Ink text.
- **Primary:** Ballpoint Blue fill, white label. One per bar (*Download*, *Choose PDF files*). The
  download options caret is joined to it as a split button.
- **Ghost:** no fill, no border; Pressed Desk on hover. Used for low-weight actions (*Start over*,
  *Install*, help).
- **Danger:** Danger Red label; red wash on hover.
- **Hover / Active / Focus:** hover tints the fill (Pressed Desk, or deeper Ballpoint on primary);
  pressing scales to 0.97 for 100ms; focus is a 2px Ballpoint outline 2px outside. Disabled is
  45% opacity. A busy button pulses its icon.

### Chips
- **Selection count:** a Blue Wash pill with Ballpoint text, 13px semibold ("2 selected").
- **Page badges:** small pills on the corner of a thumbnail: rotation (Card White, Pencil text,
  badge shadow), highlights (Highlighter Yellow), private marks (Privacy Pink, white text),
  removed objects (dark grey). Each has a 2px Desk ring to separate it from the paper.

### Cards / Containers
- **Page card** (signature): a square paper slot, then a caption line with the page number in bold
  tabular figures, the source dot and "file.pdf · p. 2" in Pencil. 10px corners, no fill at rest,
  a light Pressed Desk tint on hover, Blue Wash when selected, plus a 3px Ballpoint outline
  around the paper and a Ballpoint check disc at the top left. Rotate and delete appear in a
  floating bar at the bottom on hover (pointer devices only).
- **Dropzone:** Card White, 2px dashed Rule Line, 18px corners, centred icon, heading, one
  primary button and a short list of promises with Ballpoint ticks.
- **Mark row:** Card White, 1px border with a 4px left edge in the mark's colour, 8px corners;
  shows kind or placeholder, text and comment.

### Inputs / Fields
- **Style:** Card White, 1px Rule Line, 8px corners (6px in the side panel), 36px high (32px in
  bars and panels). Text in inputs is 16px so phones don't zoom.
- **Labels:** above the field, 12–13px, Pencil, semibold.
- **Focus:** 2px Ballpoint outline, 2px offset. **Error:** Danger Red border and a red message
  under the field.
- **Checkboxes, sliders:** native, tinted with `accent-color: Ballpoint Blue`.

### Navigation
- **View switch:** a segmented control (Card White, 1px border, 10px corners, 2px inner padding)
  with *Arrange* and *Details*; the active segment is Blue Wash with Ballpoint text.
- **Strip** (Details view): page thumbnails at 72px with the page number under them; the current
  page is Blue Wash with Ballpoint number. Hover shows a delete button at the top left.
- **Context menu:** Card White, 10px corners, menu shadow, 34px rows with icon and label; danger
  rows in red.

### Toasts
Bottom centre, at most 480px wide, stacked upwards. Dark (`toast`) with light text in light mode,
inverted in dark mode; errors are Danger Red with white text. An optional action (*Undo*) is a
small translucent button on the right. They slide up 10px and fade in over 220ms.

## Do's and Don'ts

### Do:
- **Do** use the CSS custom properties in `src/styles.css` (`--accent`, `--surface`, …), so dark mode
  follows automatically.
- **Do** keep Ballpoint Blue for interaction and selection only (The One Ink Rule).
- **Do** keep pages white with the paper shadow in both modes (The White Paper Rule), and draw on
  them with the `paper-*` tokens (The On-Paper Rule).
- **Do** give buttons a visible label on desktop. Only universal icons (undo, redo, help, close)
  may be icon-only. Under 720px secondary buttons collapse to icons; every button keeps a label
  for screen readers and a `title`.
- **Do** use `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`) and 120–260ms for motion, and leave the
  global reduced-motion override in place.
- **Do** use tabular figures for page numbers and counts.

### Don't:
- **Don't** add shadows to bars, panels, cards or buttons at rest (The Only Paper Lifts Rule).
- **Don't** introduce a second accent colour or use the signal colours decoratively.
- **Don't** load web fonts, icon fonts or anything from another origin; icons are inline SVG from
  the sprite in `index.html`.
- **Don't** hardcode colours in rules; add a custom property in the token block at the top of
  `src/styles.css` (with its dark value, if it sits on the desk). The one literal left is the
  highlight fallback `rgb(255 235 64)`, which mirrors the default yellow in `src/annotations.js`.
- **Don't** make inputs smaller than 16px text on phones.
