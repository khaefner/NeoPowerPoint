---
name: pptx-to-neopowerpoint
description: >-
  Convert a PowerPoint (.pptx) file into a NeoPowerPoint deck (deck.json + one
  HTML page per slide + shared theme.css + assets) while staying faithful to the
  original theme: colors, fonts, layout geometry, backgrounds, images, speaker
  notes. Use when the user asks to import, convert, port, or recreate a
  PowerPoint/PPTX/Keynote-export deck as a NeoPowerPoint presentation.
---

# PPTX -> NeoPowerPoint

Goal: a deck that **looks like the original** (same theme, same layout) but is made of
real, editable HTML/CSS/JS slides that NeoPowerPoint can present, sort, export as
`.neopres`, and hot-reload.

Tooling needed: `python3` only. Optional for visual comparison: LibreOffice (`soffice`)
and `pdftoppm`. No pip installs required.

## The NeoPowerPoint format (what you are producing)

```
my-deck/
├── deck.json                    # manifest
├── assets/
│   ├── theme.css                # ONE shared theme: CSS variables, fonts, base classes
│   ├── media/                   # images copied from the PPTX
│   └── fonts/                   # (optional) font files, only if license allows
└── slides/
    ├── 01-title/index.html      # one folder per slide, always index.html
    └── 02-agenda/index.html
```

`deck.json` (see `src/types/deck.ts` in the NeoPowerPoint repo):

```json
{
  "version": "1.0.0",
  "title": "Deck title",
  "author": "optional",
  "aspectRatio": "16:9",
  "customWidth": 1920,
  "customHeight": 1080,
  "theme": "dark",
  "defaultTransition": "fade",
  "slides": [
    { "id": "slide-1", "title": "Title", "path": "slides/01-title/index.html",
      "notes": "speaker notes", "transition": "fade" }
  ]
}
```

Rules that matter:
- `customWidth`/`customHeight` are what the app actually uses to scale the slide. Always set them
  (extractor reports the canvas; 16:9 -> 1920x1080, 4:3 -> 1920x1440).
- Each slide is shown in an iframe whose viewport **is** `customWidth x customHeight` CSS px, so
  design every slide on a fixed canvas of exactly that size. No `vw`/`vh`/media queries.
- Slides are served from `neopres://deck/<path>`; relative URLs work, so slides reference shared
  files as `../../assets/theme.css`, `../../assets/media/foo.png`. Never use absolute paths or
  `http(s)` URLs (decks must work offline and inside a `.neopres` zip).
- `path` is relative, posix slashes, must exist. `id` unique. `notes` = speaker notes (plain text).
- Slides can navigate via `window.parent.postMessage({type:'NEODECK_NEXT'|'NEODECK_PREV'|'NEODECK_GOTO', index}, '*')`.

## Workflow

### 1. Extract (never parse the PPTX by hand)

```bash
python3 <skill-dir>/scripts/extract_pptx.py input.pptx --out ./pptx-extract --render
```

Outputs `extract.json`, `media/`, and (with `--render`) `reference/slide-NN.png`.
Read [`references/extract-schema.md`](references/extract-schema.md) for the JSON layout.
Key facts: all `x/y/w/h/size_px` are already in the target canvas px; fonts/colors are
already resolved through the master -> layout -> shape inheritance chain; theme colors
are resolved to hex.

### 2. LOOK at the reference images before writing anything

Open several `reference/slide-NN.png` (title slide, a content slide, a dense slide, one with
images). The JSON tells you the numbers; the PNG tells you the design intent (gradients,
overlays, visual hierarchy). Note: LibreOffice skips hidden slides, so PNG numbering can lag
behind the `number` field; slides with `"hidden": true` should normally be **skipped**
(mention it to the user) unless they ask to keep them.

### 3. Build the shared theme FIRST (`assets/theme.css`)

Start from [`templates/theme.css`](templates/theme.css) and fill it from `extract.json`:
- `theme.colors` -> `--dk1 --lt1 --dk2 --lt2 --accent1..6` (keep the PPTX names).
- `theme.fonts` + the fonts actually used in runs (these often differ from the theme fonts:
  count `font` values across all runs and take the dominant heading/body fonts). Give a
  sensible fallback stack. If a font file is available and its license permits, add
  `@font-face` pointing to `assets/fonts/`; otherwise just use the stack - do not fetch from a CDN.
- canvas size variables.

Slides must use these variables (`var(--accent1)`) rather than repeating hex codes, except
for one-off colors that are not in the theme.

### 4. Group slides by layout, then build one pattern per layout

`slides[i].layout` points into `layouts{}`. Slides sharing a layout share decor (logos,
side panels, gradient overlays, footers). Put reusable decor into CSS classes in
`theme.css` (e.g. `.layout-title`, `.layout-content`) and apply the class to `.slide`.
Emit decor from `master.decor_shapes` (only if `show_master_shapes`) then
`layouts[layout].decor_shapes`, in that order, **before** slide shapes.
Background = `slide.effective_background` (already resolved slide > layout > master).

### 5. Generate each slide (`slides/NN-slug/index.html`)

Start from [`templates/slide.html`](templates/slide.html). Mapping rules:

| PPTX (extract.json)                | HTML                                                                 |
|------------------------------------|----------------------------------------------------------------------|
| shape `x,y,w,h`                    | `position:absolute; left/top/width/height` in px (copy verbatim)     |
| `rotation_deg`, `flipH/V`          | `transform: rotate(..) scale(-1,1)`                                  |
| `fill` solid / gradient / image    | `background` (gradient `angle_deg` -> CSS `linear-gradient(<deg+90>deg ...)`, OOXML 0deg = left-to-right, clockwise) |
| `line`                             | `border` (px width, `dash` -> dashed/dotted)                         |
| `geometry` roundRect/ellipse/...   | `border-radius` / `clip-path`; unknown shapes -> inline SVG          |
| text paragraph `algn l/ctr/r/just` | `text-align left/center/right/justify`                               |
| run `size_px`, `bold`, `color`, `font` | `font-size`, `font-weight`, `color`, `font-family`               |
| `uppercase`, `letter_spacing_pt`   | `text-transform:uppercase`, `letter-spacing: pt * (size_px/size_pt)` px (the same pt->px factor as fonts, 2.0 for 16:9 at 1920) |
| `line_spacing.percent`             | `line-height: percent/100`                                           |
| `space_before/after.px`            | `margin-top/bottom`                                                  |
| `bullet` char + `marL`,`indent`    | real `<ul>`/`<li>` with the same bullet char (`data-bullet`) and padding |
| `bullet: "auto:*"`                 | `<ol>` with matching `list-style-type`                               |
| `body.anchor t/ctr/b`              | flex `justify-content` flex-start/center/flex-end                    |
| `body.pad_*`                       | `padding`                                                            |
| `body.autofit.font_scale_pct`      | multiply font sizes by that % (PowerPoint already shrank the text)   |
| `\n` run (`<a:br>`)                | `<br>`                                                               |
| run `link`                         | `<a href>` (external only)                                           |
| picture `image`, `crop_pct`        | `<img>` in `overflow:hidden` wrapper; crop via negative offsets/`object-position` |
| `table`                            | real `<table>` with `column_widths_px`, row heights, cell fills      |
| `chart`                            | SVG/Canvas chart from `series`/`categories`/`values` using theme accent colors (or Chart.js vendored under assets/) |
| `unsupported` (SmartArt, OLE)      | rebuild from the reference PNG as HTML/SVG; as a last resort embed the PNG, and tell the user |
| decorative empty shapes            | keep them (they carry the theme: panels, overlays, accent bars)      |

Fidelity guidance:
- Keep **geometry exactly**; do not "improve" spacing or snap to grids.
- Keep **content verbatim** (typos included) unless the user says otherwise. Preserve line breaks.
- Prefer semantic markup (`<h1>` for title placeholder, `<ul>`, `<table>`) styled to match - it keeps
  slides editable. Absolute positioning of boxes is fine; absolute positioning of every word is not.
- Text boxes: set `white-space: normal` and let wrapping happen, but if the browser font is a
  fallback with different metrics, verify nothing overflows and adjust `letter-spacing`/size slightly.
- Animations/transitions: PPTX animations are not extracted. Use `transition: "fade"` in the
  manifest, and optionally add CSS entrance effects only if the user asks.
- Slide `title`: use the title placeholder text (first line only); fall back to `Slide N`.
- Copy `notes` into `deck.json` verbatim.
- Copy only the media files actually referenced from `extract/media/` to `assets/media/`.

### 6. Generate deck and manifest, then validate

You can use the helper script or generate custom HTML:
```bash
python3 <skill-dir>/scripts/generate_deck.py --extract ./pptx-extract/extract.json --out ./my-deck
```

Then validate the deck:
```bash
python3 <skill-dir>/scripts/validate_deck.py ./my-deck
```
Fix every ERROR; address WARNs (remote URLs, missing charset, etc.).

### 7. Visual QA loop (required, not optional)

For at least the first slide, one slide per distinct layout, and any dense slide:
1. Open the deck (`npm start` in the NeoPowerPoint repo -> **Open Folder**, or render the HTML at
   1920x1080 with a headless browser if available).
2. Compare to `reference/slide-NN.png`: background, panel positions, font sizes, colors, alignment,
   image placement, text overflow.
3. Fix discrepancies in `theme.css` first (fixes all slides), then the individual slide.

Stop iterating when differences are only anti-aliasing / font-substitution level. Report any
remaining deviation honestly (missing fonts, unsupported SmartArt, dropped animations).

### 8. Deliver

- Output folder name: slug of the deck title (default next to the input file) - ask only if ambiguous.
- Optionally export: in the app **Menu -> Export as .neopres**, or zip the folder contents
  (`deck.json` must be at the zip root).
- Final message to the user: slide count, hidden slides skipped, fonts used (and whether they were
  embedded or substituted), anything approximated (charts, SmartArt, animations).

## Failure modes to check for

- **Wrong colors**: you used `#000/#fff` defaults - re-check `effective_background` and `color` on runs;
  runs without `color` inherit the layout default - use `theme` text color, not black.
- **Everything slightly too big/small**: canvas mismatch. `customWidth/Height` must equal `canvas` in extract.json.
- **Missing decor (logos, side panels)**: you skipped `layouts[...].decor_shapes` / `master.decor_shapes`.
- **Text clipped on one slide**: `autofit.font_scale_pct` ignored, or fallback font is wider.
- **Slide looks white in preview**: slide HTML must set its own background (iframe default is white).
- **Images broken after export**: path not relative to the slide (`../../assets/media/...`).
- **Placeholder ghost text** ("Click to add title") copied from layouts: only copy slide-level text.

## Do not

- Do not load fonts, scripts or images from the internet.
- Do not collapse the whole slide into one screenshot (defeats the purpose) except for unsupported objects.
- Do not rewrite or summarize the user's content.
- Do not commit `pptx-extract/` scratch output unless asked; only the generated deck folder.
