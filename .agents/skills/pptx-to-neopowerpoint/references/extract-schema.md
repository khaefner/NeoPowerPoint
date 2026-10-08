# extract.json schema

Produced by `scripts/extract_pptx.py`. All geometry/font values are in the **target canvas**
coordinate system (default 1920 px wide; height follows the PPTX aspect ratio).

```jsonc
{
  "source": "deck.pptx",
  "canvas": { "width": 1920, "height": 1080, "source_emu": [12192000, 6858000] },

  "theme": {
    "colors": { "dk1": "#000000", "lt1": "#ffffff", "dk2": "#3a3a3a", "lt2": "#f1f1f1",
                "accent1": "#e00016", "...": "...", "hlink": "#9d83f7" },
    "fonts":  { "heading": "Aptos Display", "body": "Aptos" },   // THEME fonts; runs often override
    "color_map": { "bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2" }
  },

  "master":  { "background": Fill|null, "decor_shapes": [Shape] },   // non-placeholder shapes
  "layouts": { "ppt/slideLayouts/slideLayout1.xml": {
      "name": "Title Slide", "show_master_shapes": true,
      "background": Fill|null, "decor_shapes": [Shape] } },

  "slides": [{
    "number": 1,
    "title": "text of the title placeholder (may contain \n)",
    "hidden": false,                       // true = slide hidden in PowerPoint (usually skip)
    "layout": "ppt/slideLayouts/slideLayout1.xml",
    "show_master_shapes": true,
    "background": Fill|null,               // slide-own background only
    "effective_background": Fill|null,     // slide > layout > master (USE THIS)
    "notes": "speaker notes or null",
    "shapes": [Shape]                      // document order == z-order (first = back)
  }]
}
```

## Fill
```jsonc
{ "type": "solid", "color": "#120f3a" | "rgba(r,g,b,a)" }
{ "type": "gradient", "angle_deg": 135, "stops": [{ "pos": 0, "color": "#303e8a" }, { "pos": 30, "color": "rgba(48,62,138,0)" }] }
{ "type": "image", "image": "media/image3.png" }     // relative to the extract dir
{ "type": "none" }
```
`pos` is 0-100 (%). OOXML gradient angle: 0 = left->right, increasing clockwise;
CSS equivalent is `linear-gradient(<angle_deg + 90>deg, ...)`.

## Shape
```jsonc
{
  "name": "Title 3", "kind": "sp" | "pic" | "graphicFrame" | "line",
  "placeholder": "title" | "body" | "dt" | "ftr" | "sldNum" | ...,   // present for placeholders
  "x": 94.9, "y": 289, "w": 1732, "h": 379,          // canvas px (group transforms already applied)
  "rotation_deg": 0, "flipH": true, "flipV": true,   // only when set
  "geometry": "rect" | "roundRect" | "ellipse" | "custom" | ..., "geometry_adjust": { "adj": "val 16667" },
  "fill": Fill, "fill_from_style": "#hex",           // style-referenced fill (approximate)
  "line": { "color": "#hex", "width_px": 2, "dash": "solid" },
  "shadow": true,
  "alt_text": "...",

  "text": {
    "body": { "anchor": "t|ctr|b", "pad_left": 19, "pad_top": 9.6, "wrap": "square",
              "autofit": { "font_scale_pct": 92.5 } | "shape" },
    "paragraphs": [{
      "level": 0, "algn": "l|ctr|r|just", "marL": 36, "indent": -36,      // px
      "line_spacing": { "percent": 90 } | { "px": 40 },
      "space_before": { "px": 20 }, "space_after": { "percent": 0 },
      "bullet": null | "•" | "auto:arabicPeriod", "bullet_color": "#hex",
      "runs": [{ "text": "Hello", "size_pt": 24, "size_px": 48, "bold": true, "italic": false,
                 "underline": true, "strike": true, "uppercase": true, "baseline": 30,
                 "letter_spacing_pt": 1.5, "color": "#9e83f7", "font": "Castoro",
                 "link": "https://...", "field": "slidenum" },
               { "text": "\n" }]                                            // line break
    }]                                    // paragraphs with "empty": true carry only style
  },

  "image": "media/image3.png",  "crop_pct": { "l": 0, "t": 12.5, "r": 0, "b": 12.5 },     // pic

  "table": { "column_widths_px": [..], "first_row_header": true, "banded_rows": false,
             "rows": [{ "height_px": 60, "cells": [{ "text": {paragraphs...}, "fill": Fill,
                                                      "gridSpan": 2, "rowSpan": 1 }] }] },

  "chart": { "types": ["barChart"], "bar_direction": "col", "grouping": "clustered", "title": "...",
             "has_legend": true,
             "series": [{ "name": "2025", "categories": ["Q1","Q2"], "values": ["10","12"], "color": "#hex" }] },

  "unsupported": "diagram"     // SmartArt/OLE/etc: rebuild from reference PNG
}
```

## Known limits (tell the user when they apply)
- Animations, slide transitions, embedded video/audio, SmartArt, WordArt effects, 3D, and
  custom freeform geometry (`custGeom`) are not converted.
- `clrMapOvr` (per-slide color remapping) is ignored.
- Chart styling is approximated (type, series, categories, values, series colors).
- Font files are not extracted from the PPTX; fonts must be installed/vendored separately.
