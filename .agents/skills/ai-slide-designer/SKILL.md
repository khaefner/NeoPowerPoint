---
name: ai-slide-designer
description: >-
  Design or redesign a NeoPowerPoint presentation slide matching the theme,
  typography, color palette, and layout geometry of the current deck or slide.
  Use when the user asks to generate, design, restyle, create an AI slide, or
  add visual layouts (multi-column cards, stat callouts, timelines, comparisons).
---

# AI Slide Designer for NeoPowerPoint

Goal: Generate beautiful, responsive, on-theme HTML/CSS slides that match the presentation's design language and can be presented directly in NeoPowerPoint.

## 1. NeoPowerPoint Slide Architecture

Every presentation in NeoPowerPoint contains:
- `deck.json`: Presentation manifest specifying `customWidth` (usually `1920`), `customHeight` (usually `1080`), `aspectRatio`, and slides array.
- `assets/theme.css`: Shared theme stylesheet defining CSS variables (colors, fonts, borders), background styles, and reusable utility classes.
- `slides/<folder-slug>/index.html`: Individual slide HTML document referencing `../../assets/theme.css`.

### Geometry Constraints
- **Fixed Canvas**: Design strictly for the dimensions in `deck.json` (`1920px` width x `1080px` height).
- **No `vw` or `vh`**: Use absolute pixels or percentages within fixed containers.
- **Offline / Local URLs**: Reference shared assets via relative paths:
  - `<link rel="stylesheet" href="../../assets/theme.css">`
  - Images: `../../assets/media/<name>`
- Do not use external CDN scripts that block offline presentations.

---

## 2. Extracting Current Theme Context

Before generating a new slide, inspect the presentation:
1. Read `deck.json` for dimensions and slide order.
2. Read `assets/theme.css` for:
   - Primary colors (e.g. `--accent-primary`, `--bg-surface`, `--text-main`, `--text-muted`).
   - Font family definitions.
   - Container styles (e.g. `.slide-container`, `.theme-dark`, `.card`).
3. (Optional) Run the theme extractor helper:
   ```bash
   python3 .agents/skills/ai-slide-designer/scripts/extract_theme.py <deck-path>
   ```
4. Read the current slide or adjacent slides (e.g., `slides/01-.../index.html`) to copy exact headers, typography scale, padding, and layout motifs.

---

## 3. High-Quality Slide Layout Patterns

Choose a layout pattern that best suits the user's content:

### Pattern A: 3-Column / Card Grid (Features, Pillars, Architectures)
```html
<div class="slide-container">
  <div class="slide-header">
    <span class="slide-kicker">ARCHITECTURE</span>
    <h1 class="slide-title">Core Principles</h1>
    <p class="slide-subtitle">Three pillars governing resilient network systems</p>
  </div>
  <div class="grid-3">
    <div class="feature-card">
      <div class="card-icon">⚡</div>
      <h3 class="card-title">Performance</h3>
      <p class="card-desc">Sub-millisecond latency with predictive routing.</p>
    </div>
    <!-- 2 more cards -->
  </div>
</div>
```

### Pattern B: Split Screen / Comparison (Before vs After, Pros vs Cons)
```html
<div class="slide-container">
  <div class="slide-header">
    <h1 class="slide-title">Architecture Evolution</h1>
  </div>
  <div class="split-columns">
    <div class="col-half">
      <div class="panel panel-left">...</div>
    </div>
    <div class="col-half">
      <div class="panel panel-right">...</div>
    </div>
  </div>
</div>
```

### Pattern C: Key Metrics / Hero Stat Callouts
```html
<div class="slide-container">
  <div class="slide-header">
    <h1 class="slide-title">Impact & Performance</h1>
  </div>
  <div class="stats-row">
    <div class="stat-box">
      <div class="stat-number">99.99%</div>
      <div class="stat-label">System Uptime</div>
    </div>
    <div class="stat-box">
      <div class="stat-number">10x</div>
      <div class="stat-label">Throughput Multiplier</div>
    </div>
  </div>
</div>
```

### Pattern D: Step-by-Step Flow / Timeline
Use horizontal flexboxes with connectors (`→` or SVG arrows).

---

## 4. Animation Support (Optional)

NeoPowerPoint natively supports stepwise presentation animations using CSS classes:
- Target elements can include:
  `class="neo-anim-target neo-anim-step-1 neo-anim-fade anim-hidden" data-anim-step="1" data-anim-type="entr" data-anim-effect="fade"`
- When presenting, pressing `Space` or `Right Arrow` advances through steps before transitioning to the next slide.

---

## 5. Output Format

When creating a slide:
1. Create directory `slides/<timestamp-or-slug>/index.html`.
2. Write full HTML containing:
   - `<!DOCTYPE html>`
   - Link to `../../assets/theme.css`
   - Slide body with inline `<style>` extending `theme.css` if necessary.
3. Update `deck.json` to insert the slide metadata directly after the user's currently selected slide.
