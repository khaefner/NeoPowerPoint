#!/usr/bin/env python3
"""
build_deck.py - Generates the complete NeoPowerPoint presentation from extract.json.
Faithful to original PPTX styling, layout, fonts, geometry, and speaker notes.
"""

import argparse
import json
import html
import os
import re
import sys

def slugify(text):
    text = re.sub(r'[^a-zA-Z0-9]+', '-', text.strip().lower())
    return text.strip('-')[:35] or 'slide'

def css_angle(ooxml_ang):
    if ooxml_ang is None:
        return 90
    return (ooxml_ang + 90) % 360

def css_gradient(fill):
    ang = css_angle(fill.get('angle_deg', 0))
    stops = fill.get('stops', [])
    if not stops:
        return 'transparent'
    stop_strs = []
    for s in stops:
        pos = s.get('pos', 0)
        col = s.get('color', '#000000')
        stop_strs.append(f'{col} {pos}%')
    return f'linear-gradient({ang:.1f}deg, {", ".join(stop_strs)})'

def format_fill_css(fill):
    if not fill or fill.get('type') == 'none':
        return 'background: transparent;'
    if fill.get('type') == 'solid':
        return f'background-color: {fill.get("color", "transparent")};'
    if fill.get('type') == 'gradient':
        return f'background: {css_gradient(fill)};'
    if fill.get('type') == 'image':
        img_path = fill.get("image")
        return f"background-image: url('../../assets/{img_path}'); background-size: cover;"
    return ''

def format_line_css(line):
    if not line:
        return ''
    w = max(1.0, line.get('width_px', 1.0))
    col = line.get('color', '#ffffff')
    dash = 'solid'
    if line.get('dash') in ('dash', 'dashDot', 'lgDash'):
        dash = 'dashed'
    elif line.get('dash') in ('dot', 'sysDot'):
        dash = 'dotted'
    return f'border: {w:.1f}px {dash} {col};'

def render_run(run, slide_num, font_scale=1.0):
    text = run.get('text', '')
    if run.get('field') == 'slidenum' or text == '‹#›':
        text = str(slide_num)
    
    if not text:
        return ''

    styles = []
    font = run.get('font')
    if font:
        if 'Castoro' in font or 'Georgia' in font:
            styles.append('font-family: var(--font-heading);')
        elif 'Nunito Sans' in font:
            styles.append('font-family: var(--font-body);')
        elif 'Aptos' in font:
            styles.append('font-family: var(--font-sans);')
        else:
            safe_font = font.replace('"', '').replace("'", "")
            styles.append(f"font-family: '{safe_font}', sans-serif;")

    sz = run.get('size_px')
    if sz:
        styles.append(f'font-size: {(sz * font_scale):.1f}px;')
    
    col = run.get('color')
    if col:
        styles.append(f'color: {col};')
    
    if run.get('bold'):
        styles.append('font-weight: bold;')
    if run.get('italic'):
        styles.append('font-style: italic;')
    if run.get('uppercase'):
        styles.append('text-transform: uppercase;')
    
    baseline = run.get('baseline', 0)
    if baseline < 0:
        styles.append('vertical-align: sub; font-size: 0.65em;')
    elif baseline > 0:
        styles.append('vertical-align: super; font-size: 0.65em;')

    spc = run.get('letter_spacing_pt')
    if spc:
        styles.append(f'letter-spacing: {(spc * 2.0):.1f}px;')

    escaped = html.escape(text).replace('\n', '<br>')
    style_attr = f' style="{" ".join(styles)}"' if styles else ''
    
    if run.get('link'):
        href = html.escape(run['link'])
        return f'<a href="{href}" target="_blank" rel="noopener"{style_attr}>{escaped}</a>'
    return f'<span{style_attr}>{escaped}</span>'

def render_paragraph(p, slide_num, font_scale=1.0):
    p_styles = []
    algn = p.get('algn', 'l')
    if algn == 'ctr':
        p_styles.append('text-align: center;')
    elif algn == 'r':
        p_styles.append('text-align: right;')
    elif algn == 'just':
        p_styles.append('text-align: justify;')
    else:
        p_styles.append('text-align: left;')

    ln_spc = p.get('line_spacing')
    if ln_spc:
        if 'percent' in ln_spc:
            p_styles.append(f'line-height: {ln_spc["percent"] / 100:.2f};')
        elif 'px' in ln_spc:
            p_styles.append(f'line-height: {ln_spc["px"]:.1f}px;')
    else:
        p_styles.append('line-height: 1.2;')

    if p.get('space_before', {}).get('px'):
        p_styles.append(f'margin-top: {p["space_before"]["px"]:.1f}px;')
    if p.get('space_after', {}).get('px'):
        p_styles.append(f'margin-bottom: {p["space_after"]["px"]:.1f}px;')

    runs_html = ''.join(render_run(r, slide_num, font_scale) for r in p.get('runs', []))
    if not runs_html.strip():
        return ''
    bullet = p.get('bullet')
    mar_l = p.get('marL', 0)
    indent = p.get('indent', 0)

    if bullet:
        bullet_char = html.escape(bullet)
        indent_val = max(24.0, abs(indent) if indent else 32.0)
        p_styles.append(f'position: relative; padding-left: {mar_l:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        first_run = p.get('runs', [{}])[0] if p.get('runs') else {}
        bullet_sz = first_run.get('size_px', 24.0) * font_scale
        bullet_col = first_run.get('color', 'inherit')
        bullet_span = f'<span style="position: absolute; left: {(mar_l - indent_val):.1f}px; font-size: {bullet_sz:.1f}px; color: {bullet_col}; line-height: inherit; user-select: none;">{bullet_char}</span>'
        return f'<p{style_attr}>{bullet_span}{runs_html}</p>'
    else:
        if mar_l > 0:
            p_styles.append(f'padding-left: {mar_l:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        return f'<p{style_attr}>{runs_html}</p>'

def render_table(sh, slide_num):
    tbl = sh.get('table', {})
    cols = tbl.get('column_widths_px', [])
    rows = tbl.get('rows', [])
    x, y, w, h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)

    html_out = [f'<table class="slide-table" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;">']
    html_out.append('  <colgroup>')
    for cw in cols:
        html_out.append(f'    <col style="width:{cw:.1f}px;">')
    html_out.append('  </colgroup>')
    html_out.append('  <tbody>')

    for r_idx, row in enumerate(rows):
        rh = row.get('height_px', 40.0)
        # Banded row styling: header row slightly darker tint, alternating rows
        if r_idx == 0:
            bg_col = '#f4d7d7'
            font_weight = 'font-weight: bold;'
        elif r_idx % 2 == 0:
            bg_col = '#f4d7d7'
            font_weight = ''
        else:
            bg_col = '#fcf1f1'
            font_weight = ''

        html_out.append(f'    <tr style="height:{rh:.1f}px; background-color:{bg_col};">')
        for c_idx, cell in enumerate(row.get('cells', [])):
            c_fill = cell.get('fill')
            cell_bg = c_fill.get('color') if c_fill and c_fill.get('type') == 'solid' else bg_col
            
            p_elems = cell.get('text', {}).get('paragraphs', [])
            cell_content = ''.join(render_paragraph(p, slide_num, font_scale=1.0) for p in p_elems)
            
            # Check cell text alignment
            cell_align = 'left'
            if p_elems and p_elems[0].get('algn') == 'r':
                cell_align = 'right'
            elif p_elems and p_elems[0].get('algn') == 'ctr':
                cell_align = 'center'

            cell_style = f'border: 1px solid #ffffff; padding: 12px 18px; text-align: {cell_align}; background-color: {cell_bg}; {font_weight}'
            html_out.append(f'      <td style="{cell_style}">{cell_content}</td>')
        html_out.append('    </tr>')

    html_out.append('  </tbody>')
    html_out.append('</table>')
    return '\n'.join(html_out)

def render_shape(sh, slide_num):
    kind = sh.get('kind')
    geom = sh.get('geometry')
    x, y, w, h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)
    rot = sh.get('rotation_deg')
    flip_h = sh.get('flipH')
    flip_v = sh.get('flipV')
    fill = sh.get('fill')
    line = sh.get('line')
    text = sh.get('text')
    img = sh.get('image')

    # Handle Table
    if kind == 'graphicFrame' and sh.get('table'):
        return render_table(sh, slide_num)

    # Handle Pictures / Images
    if kind == 'pic' or img:
        img_src = f'../../assets/{img}'
        crop = sh.get('crop_pct')
        transforms = []
        if rot:
            transforms.append(f'rotate({rot:.1f}deg)')
        if flip_h:
            transforms.append('scaleX(-1)')
        if flip_v:
            transforms.append('scaleY(-1)')
        trans_css = f'transform: {" ".join(transforms)};' if transforms else ''

        if crop:
            # overflow hidden container
            return f'<div class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:hidden;{trans_css}"><img src="{img_src}" style="width:100%;height:100%;object-fit:cover;" alt=""></div>'
        else:
            line_css = format_line_css(line)
            return f'<img class="pic" src="{img_src}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;{line_css}{trans_css}" alt="">'

    # Handle Chevrons (like on slide 12)
    if geom == 'chevron':
        fill_col = fill.get('color', '#ef2640') if fill else '#ef2640'
        return f'<svg class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"><polygon points="0,0 {w*0.65:.1f},0 {w:.1f},{h/2:.1f} {w*0.65:.1f},{h:.1f} 0,{h:.1f} {w*0.35:.1f},{h/2:.1f}" fill="{fill_col}"/></svg>'

    # Handle Left Brace (curly bracket on slide 10)
    if geom == 'leftBrace':
        line_col = line.get('color', '#003f62') if line else '#003f62'
        lw = line.get('width_px', 2.0) if line else 2.0
        # Check if rotated (e.g. rot=270 is horizontal bracket)
        if rot == 270.0:
            # Draw horizontal curly brace bracket pointing downward
            # Container width is h, height is w
            bw, bh = h, max(w, 40.0)
            bx, by = x + (w - bw)/2, y + (h - bh)/2
            mid = bw / 2
            d_path = f'M 0,5 C 20,5 20,{bh-15} 40,{bh-15} L {mid-30:.1f},{bh-15} C {mid-15:.1f},{bh-15} {mid-10:.1f},{bh-2} {mid:.1f},{bh-2} C {mid+10:.1f},{bh-2} {mid+15:.1f},{bh-15} {mid+30:.1f},{bh-15} L {bw-40:.1f},{bh-15} C {bw-20:.1f},{bh-15} {bw-20:.1f},5 {bw:.1f},5'
            return f'<svg class="abs" style="left:{bx:.1f}px;top:{by:.1f}px;width:{bw:.1f}px;height:{bh:.1f}px;overflow:visible;"><path d="{d_path}" fill="none" stroke="{line_col}" stroke-width="{lw:.1f}"/></svg>'
        else:
            return f'<svg class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"><path d="M {w},0 C {w*0.3},0 {w*0.3},{h*0.4} 0,{h*0.5} C {w*0.3},{h*0.6} {w*0.3},{h} {w},{h}" fill="none" stroke="{line_col}" stroke-width="{lw:.1f}"/></svg>'

    # Handle Lines and Arrows
    if kind == 'line' or geom == 'line' or (line and w <= 1.0 and h > 1.0) or (line and h <= 1.0 and w > 1.0):
        line_col = line.get('color', '#ffffff') if line else '#ffffff'
        lw = max(1.0, line.get('width_px', 1.0)) if line else 1.0
        is_arrow = 'Arrow' in sh.get('name', '')
        
        if w <= 1.0: # Vertical line
            if is_arrow:
                arrow_sz = max(6.0, lw * 3.5)
                return f'''<svg class="abs" style="left:{(x - arrow_sz/2):.1f}px;top:{y:.1f}px;width:{arrow_sz:.1f}px;height:{h:.1f}px;overflow:visible;">
  <line x1="{arrow_sz/2:.1f}" y1="0" x2="{arrow_sz/2:.1f}" y2="{(h - arrow_sz):.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"/>
  <polygon points="0,{(h - arrow_sz):.1f} {arrow_sz:.1f},{(h - arrow_sz):.1f} {arrow_sz/2:.1f},{h:.1f}" fill="{line_col}"/>
</svg>'''
            else:
                return f'<div class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{lw:.1f}px;height:{h:.1f}px;background:{line_col};"></div>'
        elif h <= 1.0: # Horizontal line
            if is_arrow:
                arrow_sz = max(6.0, lw * 3.5)
                return f'''<svg class="abs" style="left:{x:.1f}px;top:{(y - arrow_sz/2):.1f}px;width:{w:.1f}px;height:{arrow_sz:.1f}px;overflow:visible;">
  <line x1="0" y1="{arrow_sz/2:.1f}" x2="{(w - arrow_sz):.1f}" y2="{arrow_sz/2:.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"/>
  <polygon points="{(w - arrow_sz):.1f},0 {(w - arrow_sz):.1f},{arrow_sz:.1f} {w:.1f},{arrow_sz/2:.1f}" fill="{line_col}"/>
</svg>'''
            else:
                return f'<div class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{lw:.1f}px;background:{line_col};"></div>'
        else:
            # Diagonal line / arrow
            arrow_sz = max(8.0, lw * 3.0) if is_arrow else 0
            if flip_h and flip_v:
                x1, y1, x2, y2 = w, 0, 0, h
            elif flip_v:
                x1, y1, x2, y2 = 0, h, w, 0
            elif flip_h:
                x1, y1, x2, y2 = w, h, 0, 0
            else:
                x1, y1, x2, y2 = 0, 0, w, h
            
            arrowhead_svg = ''
            if is_arrow:
                arrowhead_svg = f'''<defs>
    <marker id="arr_{slide_num}_{int(x)}_{int(y)}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="{line_col}"/>
    </marker>
  </defs>'''
                marker_attr = f' marker-end="url(#arr_{slide_num}_{int(x)}_{int(y)})"'
            else:
                marker_attr = ''

            return f'''<svg class="abs" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;">
  {arrowhead_svg}
  <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"{marker_attr}/>
</svg>'''

    # Build Shape container (div)
    classes = ['abs']
    styles = [
        f'left: {x:.1f}px;',
        f'top: {y:.1f}px;',
        f'width: {w:.1f}px;',
        f'height: {h:.1f}px;'
    ]

    # Geometry radius
    if geom == 'ellipse':
        styles.append('border-radius: 50%;')
    elif geom == 'roundRect':
        styles.append('border-radius: 12px;')

    # Fill and Line
    fill_css = format_fill_css(fill)
    if fill_css:
        styles.append(fill_css)
    line_css = format_line_css(line)
    if line_css:
        styles.append(line_css)
    if sh.get('shadow'):
        styles.append('box-shadow: 0 4px 14px rgba(0,0,0,0.3);')

    transforms = []
    if rot:
        transforms.append(f'rotate({rot:.1f}deg)')
    if flip_h:
        transforms.append('scaleX(-1)')
    if flip_v:
        transforms.append('scaleY(-1)')
    if transforms:
        styles.append(f'transform: {" ".join(transforms)};')

    has_text_content = False
    if text:
        for p in text.get('paragraphs', []):
            if any(r.get('text', '').strip() or r.get('field') == 'slidenum' or r.get('text') == '‹#›' for r in p.get('runs', [])):
                has_text_content = True
                break

    if has_text_content:
        classes.append('tb')
        body = text.get('body', {})
        anchor = body.get('anchor', 't')
        if anchor == 'ctr':
            classes.append('anchor-ctr')
        elif anchor == 'b':
            classes.append('anchor-b')
        else:
            classes.append('anchor-t')

        pl = body.get('pad_left', 0.0)
        pt = body.get('pad_top', 0.0)
        pr = body.get('pad_right', 0.0)
        pb = body.get('pad_bottom', 0.0)
        if pl or pt or pr or pb:
            styles.append(f'padding: {pt:.1f}px {pr:.1f}px {pb:.1f}px {pl:.1f}px;')

        font_scale = 1.0
        autofit = body.get('autofit')
        if isinstance(autofit, dict) and autofit.get('font_scale_pct'):
            font_scale = autofit['font_scale_pct'] / 100.0

        p_list = [render_paragraph(p, slide_num, font_scale) for p in text.get('paragraphs', [])]
        p_list = [p for p in p_list if p]
        paragraphs_html = '\n'.join(p_list)
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        return f'<div class="{class_attr}" style="{style_attr}">\n{paragraphs_html}\n</div>'
    else:
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        return f'<div class="{class_attr}" style="{style_attr}"></div>'

def build_slide_html(slide_data, layout_data, master_data, slide_index, slide_title):
    # Determine background
    bg = slide_data.get('effective_background')
    bg_css = 'background: #ffffff;'
    if bg:
        if bg.get('type') == 'solid':
            bg_css = f'background: {bg.get("color", "#ffffff")};'
        elif bg.get('type') == 'gradient':
            bg_css = f'background: {css_gradient(bg)};'

    decor_elements = []
    # Master decor
    if slide_data.get('show_master_shapes', True) and master_data:
        for sh in master_data.get('decor_shapes', []):
            decor_elements.append(render_shape(sh, slide_index))

    # Layout decor
    if layout_data:
        for sh in layout_data.get('decor_shapes', []):
            decor_elements.append(render_shape(sh, slide_index))

    # Slide shapes
    slide_elements = []
    for sh in slide_data.get('shapes', []):
        rendered = render_shape(sh, slide_index)
        if rendered:
            slide_elements.append(rendered)

    all_content = '\n    '.join(decor_elements + slide_elements)

    html_page = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{html.escape(slide_title)}</title>
  <link rel="stylesheet" href="../../assets/theme.css">
  <style>
    .slide {{
      {bg_css}
    }}
  </style>
</head>
<body>
  <main class="slide">
    {all_content}
  </main>
</body>
</html>
'''
    return html_page

def main():
    parser = argparse.ArgumentParser(description='Generate NeoPowerPoint deck from extract.json')
    parser.add_argument('--extract', default='/tmp/neo-extract/extract.json', help='Path to extract.json')
    parser.add_argument('--out', default='security-and-ai', help='Output deck directory')
    args = parser.parse_args()

    extract_path = os.path.abspath(args.extract)
    out_dir = os.path.abspath(args.out)

    with open(extract_path, 'r') as f:
        data = json.load(f)

    masters = data.get('masters', {})
    layouts = data.get('layouts', {})
    raw_slides = data.get('slides', [])

    manifest_slides = []
    active_idx = 1

    for s in raw_slides:
        if s.get('hidden'):
            print(f'Skipping hidden slide {s.get("number")}')
            continue

        layout_key = s.get('layout')
        layout = layouts.get(layout_key, {})
        master_key = layout.get('master')
        master = masters.get(master_key, {})

        # Determine clean slide title
        slide_title = ''
        for sh in s.get('shapes', []):
            ph = sh.get('placeholder')
            ph_t = ph if isinstance(ph, str) else (ph.get('type') if isinstance(ph, dict) else None)
            if ph_t in ('title', 'ctrTitle') and sh.get('text'):
                lines = [r.get('text', '') for p in sh['text'].get('paragraphs', []) for r in p.get('runs', [])]
                full_t = ''.join(lines).strip().split('\n')[0].strip()
                if full_t:
                    slide_title = full_t
                    break

        if not slide_title:
            # Fallback to prominent text
            for sh in s.get('shapes', []):
                if sh.get('text') and sh.get('kind') == 'sp':
                    lines = [r.get('text', '') for p in sh['text'].get('paragraphs', []) for r in p.get('runs', [])]
                    txt = ' '.join(''.join(lines).split()).strip()
                    if txt and len(txt) < 80:
                        slide_title = txt.split('\n')[0].strip()
                        break

        if not slide_title:
            slide_title = f'Slide {active_idx}'

        # Clean title overrides for well-known slides
        if s.get('number') == 1:
            slide_title = 'Security & AI WG'
        elif s.get('number') == 4:
            slide_title = 'Legal Disclosures: Antitrust Guidelines'
        elif s.get('number') == 5:
            slide_title = 'Legal Disclosures: Intellectual Property & Licensing'
        elif s.get('number') == 6:
            slide_title = 'Meeting Guidelines'
        elif s.get('number') == 10:
            slide_title = 'Delta-Zero: Reducing the Window of Vulnerability Exposure'
        elif s.get('number') == 11:
            slide_title = 'A DOCSIS-Specific Threat Model'
        elif s.get('number') == 12:
            slide_title = 'Repeatable Harnesses for Code Scanning'
        elif s.get('number') == 20:
            slide_title = 'Scan Orchestration and Standard Output Manifests'
        elif s.get('number') == 21:
            slide_title = 'Scanning Harness Updates – RDK-B'

        folder_name = f'{active_idx:02d}-{slugify(slide_title)}'
        slide_dir = os.path.join(out_dir, 'slides', folder_name)
        os.makedirs(slide_dir, exist_ok=True)

        slide_html = build_slide_html(s, layout, master, active_idx, slide_title)
        with open(os.path.join(slide_dir, 'index.html'), 'w') as sf:
            sf.write(slide_html)

        rel_path = f'slides/{folder_name}/index.html'
        notes = (s.get('notes') or '').strip()

        manifest_slides.append({
            'id': f'slide-{active_idx}',
            'title': slide_title,
            'path': rel_path,
            'notes': notes,
            'transition': 'fade'
        })

        print(f'Generated slide {active_idx:02d} (orig {s.get("number")}): {slide_title} -> {rel_path}')
        active_idx += 1

    # Write deck.json
    deck_json = {
        'version': '1.0.0',
        'title': 'Security & AI WG',
        'aspectRatio': '16:9',
        'customWidth': 1920,
        'customHeight': 1080,
        'theme': 'dark',
        'defaultTransition': 'fade',
        'slides': manifest_slides
    }

    with open(os.path.join(out_dir, 'deck.json'), 'w') as df:
        json.dump(deck_json, df, indent=2)

    print(f'\nWrote deck.json with {len(manifest_slides)} slides to {out_dir}/deck.json')

if __name__ == '__main__':
    main()
