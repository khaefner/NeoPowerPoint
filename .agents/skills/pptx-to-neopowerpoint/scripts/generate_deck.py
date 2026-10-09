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

def to_roman(num):
    val = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1]
    syb = ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"]
    res = ""
    i = 0
    n = max(1, num)
    while n > 0 and i < len(val):
        for _ in range(n // val[i]):
            res += syb[i]
            n -= val[i]
        i += 1
    return res

def format_bullet_str(bullet_raw, auto_idx=1):
    if not bullet_raw:
        return ''
    if not bullet_raw.startswith('auto:'):
        return bullet_raw
    btype = bullet_raw[5:]
    if btype == 'romanLcPeriod':
        return f'{to_roman(auto_idx)}.'
    elif btype == 'romanUcPeriod':
        return f'{to_roman(auto_idx).upper()}.'
    elif btype == 'romanLcParenR':
        return f'{to_roman(auto_idx)})'
    elif btype == 'romanUcParenR':
        return f'{to_roman(auto_idx).upper()})'
    elif btype == 'arabicPeriod':
        return f'{auto_idx}.'
    elif btype == 'arabicParenR':
        return f'{auto_idx})'
    elif btype == 'alphaLcPeriod':
        return f'{chr(ord("a") + (auto_idx - 1) % 26)}.'
    elif btype == 'alphaUcPeriod':
        return f'{chr(ord("A") + (auto_idx - 1) % 26)}.'
    elif btype == 'alphaLcParenR':
        return f'{chr(ord("a") + (auto_idx - 1) % 26)})'
    elif btype == 'alphaUcParenR':
        return f'{chr(ord("A") + (auto_idx - 1) % 26)})'
    return f'{auto_idx}.'

def render_paragraph(p, slide_num, font_scale=1.0, p_idx=None, para_anim=None, auto_idx=1):
    p_styles = []
    p_classes = []
    anim_attrs = ''

    if para_anim:
        st_num = para_anim['step']
        eff_name = para_anim['effect']
        eff_type = para_anim['type']
        p_classes.append('neo-anim-target')
        p_classes.append(f'neo-anim-step-{st_num}')
        p_classes.append(f'neo-anim-{eff_name}')
        p_classes.append('anim-hidden')
        anim_attrs = f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'
        if p_idx is not None:
            anim_attrs += f' data-para-idx="{p_idx}"'
    elif p_idx is not None:
        anim_attrs = f' data-para-idx="{p_idx}"'

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
    class_attr = f' class="{" ".join(p_classes)}"' if p_classes else ''

    if p.get('empty') or not runs_html.strip():
        empty_sz = p.get('style', {}).get('size_px') or 24.0
        p_styles.append(f'min-height: {(empty_sz * font_scale):.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        return f'<p{class_attr}{style_attr}{anim_attrs}><span style="font-size: {(empty_sz * font_scale):.1f}px;">&nbsp;</span></p>'

    bullet = p.get('bullet')
    mar_l = p.get('marL', 0)
    indent = p.get('indent', 0)

    if bullet:
        bullet_text = format_bullet_str(bullet, auto_idx)
        bullet_char = html.escape(bullet_text)
        indent_val = max(24.0, abs(indent) if indent else 32.0)
        p_styles.append(f'position: relative; padding-left: {mar_l:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        first_run = p.get('runs', [{}])[0] if p.get('runs') else {}
        bullet_sz = first_run.get('size_px', 24.0) * font_scale
        bullet_col = first_run.get('color', 'inherit')
        bullet_span = f'<span style="position: absolute; left: {(mar_l - indent_val):.1f}px; font-size: {bullet_sz:.1f}px; color: {bullet_col}; line-height: inherit; user-select: none;">{bullet_char}</span>'
        return f'<p{class_attr}{style_attr}{anim_attrs}>{bullet_span}{runs_html}</p>'
    else:
        if mar_l > 0:
            p_styles.append(f'padding-left: {mar_l:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        return f'<p{class_attr}{style_attr}{anim_attrs}>{runs_html}</p>'

def render_table(sh, slide_num, shape_anim=None):
    tbl = sh.get('table', {})
    cols = tbl.get('column_widths_px', [])
    rows = tbl.get('rows', [])
    x, y, w, h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)
    spid = str(sh.get('id') or sh.get('spid') or '')

    tbl_classes = ['slide-table']
    anim_attrs = ''
    if shape_anim:
        st_num = shape_anim['step']
        eff_name = shape_anim['effect']
        eff_type = shape_anim['type']
        tbl_classes.extend(['neo-anim-target', f'neo-anim-step-{st_num}', f'neo-anim-{eff_name}', 'anim-hidden'])
        anim_attrs = f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'
    if spid:
        anim_attrs += f' data-spid="{spid}"'

    class_str = ' '.join(tbl_classes)
    html_out = [f'<table class="{class_str}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;"{anim_attrs}>']
    html_out.append('  <colgroup>')
    for cw in cols:
        html_out.append(f'    <col style="width:{cw:.1f}px;">')
    html_out.append('  </colgroup>')
    html_out.append('  <tbody>')

    for r_idx, row in enumerate(rows):
        rh = row.get('height_px', 40.0)
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

def render_shape(sh, slide_num, shape_anims=None, para_anims=None):
    if shape_anims is None: shape_anims = {}
    if para_anims is None: para_anims = {}

    spid = str(sh.get('id') or sh.get('spid') or '')
    shape_anim = shape_anims.get(spid)

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
        return render_table(sh, slide_num, shape_anim)

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

        anim_classes = ''
        anim_attrs = f' data-spid="{spid}"' if spid else ''
        if shape_anim:
            st_num = shape_anim['step']
            eff_name = shape_anim['effect']
            eff_type = shape_anim['type']
            anim_classes = f' neo-anim-target neo-anim-step-{st_num} neo-anim-{eff_name} anim-hidden'
            anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

        if crop:
            return f'<div class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:hidden;{trans_css}"{anim_attrs}><img src="{img_src}" style="width:100%;height:100%;object-fit:cover;" alt=""></div>'
        else:
            line_css = format_line_css(line)
            return f'<img class="pic{anim_classes}" src="{img_src}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;{line_css}{trans_css}" alt=""{anim_attrs}>'

    # Handle Chevrons
    if geom == 'chevron':
        fill_col = fill.get('color', '#ef2640') if fill else '#ef2640'
        anim_classes = ''
        anim_attrs = f' data-spid="{spid}"' if spid else ''
        if shape_anim:
            st_num = shape_anim['step']
            eff_name = shape_anim['effect']
            eff_type = shape_anim['type']
            anim_classes = f' neo-anim-target neo-anim-step-{st_num} neo-anim-{eff_name} anim-hidden'
            anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

        return f'<svg class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"{anim_attrs}><polygon points="0,0 {w*0.65:.1f},0 {w:.1f},{h/2:.1f} {w*0.65:.1f},{h:.1f} 0,{h:.1f} {w*0.35:.1f},{h/2:.1f}" fill="{fill_col}"/></svg>'

    # Handle Left Brace
    if geom == 'leftBrace':
        line_col = line.get('color', '#003f62') if line else '#003f62'
        lw = line.get('width_px', 2.0) if line else 2.0
        anim_classes = ''
        anim_attrs = f' data-spid="{spid}"' if spid else ''
        if shape_anim:
            st_num = shape_anim['step']
            eff_name = shape_anim['effect']
            eff_type = shape_anim['type']
            anim_classes = f' neo-anim-target neo-anim-step-{st_num} neo-anim-{eff_name} anim-hidden'
            anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

        if rot == 270.0:
            bw, bh = h, max(w, 40.0)
            bx, by = x + (w - bw)/2, y + (h - bh)/2
            mid = bw / 2
            d_path = f'M 0,5 C 20,5 20,{bh-15} 40,{bh-15} L {mid-30:.1f},{bh-15} C {mid-15:.1f},{bh-15} {mid-10:.1f},{bh-2} {mid:.1f},{bh-2} C {mid+10:.1f},{bh-2} {mid+15:.1f},{bh-15} {mid+30:.1f},{bh-15} L {bw-40:.1f},{bh-15} C {bw-20:.1f},{bh-15} {bw-20:.1f},5 {bw:.1f},5'
            return f'<svg class="abs{anim_classes}" style="left:{bx:.1f}px;top:{by:.1f}px;width:{bw:.1f}px;height:{bh:.1f}px;overflow:visible;"{anim_attrs}><path d="{d_path}" fill="none" stroke="{line_col}" stroke-width="{lw:.1f}"/></svg>'
        else:
            return f'<svg class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"{anim_attrs}><path d="M {w},0 C {w*0.3},0 {w*0.3},{h*0.4} 0,{h*0.5} C {w*0.3},{h*0.6} {w*0.3},{h} {w},{h}" fill="none" stroke="{line_col}" stroke-width="{lw:.1f}"/></svg>'

    # Handle Lines and Arrows
    if kind == 'line' or geom == 'line' or (line and w <= 1.0 and h > 1.0) or (line and h <= 1.0 and w > 1.0):
        line_col = line.get('color', '#ffffff') if line else '#ffffff'
        lw = max(1.0, line.get('width_px', 1.0)) if line else 1.0
        is_arrow = 'Arrow' in sh.get('name', '')

        anim_classes = ''
        anim_attrs = f' data-spid="{spid}"' if spid else ''
        if shape_anim:
            st_num = shape_anim['step']
            eff_name = shape_anim['effect']
            eff_type = shape_anim['type']
            anim_classes = f' neo-anim-target neo-anim-step-{st_num} neo-anim-{eff_name} anim-hidden'
            anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

        if w <= 1.0: # Vertical line
            if is_arrow:
                arrow_sz = max(6.0, lw * 3.5)
                return f'''<svg class="abs{anim_classes}" style="left:{(x - arrow_sz/2):.1f}px;top:{y:.1f}px;width:{arrow_sz:.1f}px;height:{h:.1f}px;overflow:visible;"{anim_attrs}>
  <line x1="{arrow_sz/2:.1f}" y1="0" x2="{arrow_sz/2:.1f}" y2="{(h - arrow_sz):.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"/>
  <polygon points="0,{(h - arrow_sz):.1f} {arrow_sz:.1f},{(h - arrow_sz):.1f} {arrow_sz/2:.1f},{h:.1f}" fill="{line_col}"/>
</svg>'''
            else:
                return f'<div class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{lw:.1f}px;height:{h:.1f}px;background:{line_col};"{anim_attrs}></div>'
        elif h <= 1.0: # Horizontal line
            if is_arrow:
                arrow_sz = max(6.0, lw * 3.5)
                return f'''<svg class="abs{anim_classes}" style="left:{x:.1f}px;top:{(y - arrow_sz/2):.1f}px;width:{w:.1f}px;height:{arrow_sz:.1f}px;overflow:visible;"{anim_attrs}>
  <line x1="0" y1="{arrow_sz/2:.1f}" x2="{(w - arrow_sz):.1f}" y2="{arrow_sz/2:.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"/>
  <polygon points="{(w - arrow_sz):.1f},0 {(w - arrow_sz):.1f},{arrow_sz:.1f} {w:.1f},{arrow_sz/2:.1f}" fill="{line_col}"/>
</svg>'''
            else:
                return f'<div class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{lw:.1f}px;background:{line_col};"{anim_attrs}></div>'
        else:
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

            return f'''<svg class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"{anim_attrs}>
  {arrowhead_svg}
  <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{line_col}" stroke-width="{lw:.1f}"{marker_attr}/>
</svg>'''

    # Handle Custom Geometry Paths (Freeforms, custom arrows, curved connectors)
    if sh.get('paths'):
        paths = sh['paths']
        line_col = line.get('color', '#ffffff') if line else 'none'
        lw = line.get('width_px', 1.0) if line else 1.0
        fill_col = fill.get('color', 'none') if (fill and fill.get('type') == 'solid') else 'none'

        anim_classes = ''
        anim_attrs = f' data-spid="{spid}"' if spid else ''
        if shape_anim:
            st_num = shape_anim['step']
            eff_name = shape_anim['effect']
            eff_type = shape_anim['type']
            anim_classes = f' neo-anim-target neo-anim-step-{st_num} neo-anim-{eff_name} anim-hidden'
            anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

        defs_list = []
        path_attrs = []
        head = line.get('head') if line else None
        tail = line.get('tail') if line else None

        mk_id_base = f"m_{slide_num}_{spid or int(x)}"
        if head in ('triangle', 'arrow', 'stealth'):
            head_id = f"{mk_id_base}_head"
            defs_list.append(f'''<marker id="{head_id}" markerWidth="8" markerHeight="8" refX="2" refY="4" orient="auto-start-reverse">
  <path d="M 0 1 L 8 4 L 0 7 z" fill="{line_col}"/>
</marker>''')
            path_attrs.append(f'marker-end="url(#{head_id})"')
        if tail in ('triangle', 'arrow', 'stealth'):
            tail_id = f"{mk_id_base}_tail"
            defs_list.append(f'''<marker id="{tail_id}" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
  <path d="M 8 1 L 0 4 L 8 7 z" fill="{line_col}"/>
</marker>''')
            path_attrs.append(f'marker-start="url(#{tail_id})"')

        defs_html = f"<defs>\n{''.join(defs_list)}\n</defs>\n" if defs_list else ""
        extra_p_attr = (" " + " ".join(path_attrs)) if path_attrs else ""

        svg_paths = []
        for p_info in paths:
            pw, ph = p_info.get('w', w), p_info.get('h', h)
            d_val = p_info.get('d', '')
            svg_paths.append(f'''<svg class="abs{anim_classes}" viewBox="0 0 {pw} {ph}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;overflow:visible;"{anim_attrs}>
  {defs_html}<path d="{d_val}" fill="{fill_col}" stroke="{line_col}" stroke-width="{lw:.1f}" vector-effect="non-scaling-stroke"{extra_p_attr}/>
</svg>''')
        return '\n'.join(svg_paths)

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

    has_text_content = False
    if text:
        for p in text.get('paragraphs', []):
            if any(r.get('text', '').strip() or r.get('field') == 'slidenum' or r.get('text') == '‹#›' for r in p.get('runs', [])):
                has_text_content = True
                break

    transforms = []
    if rot:
        transforms.append(f'rotate({rot:.1f}deg)')
    if not has_text_content:
        if flip_h:
            transforms.append('scaleX(-1)')
        if flip_v:
            transforms.append('scaleY(-1)')
    if transforms:
        styles.append(f'transform: {" ".join(transforms)};')

    anim_attrs = f' data-spid="{spid}"' if spid else ''

    if shape_anim:
        st_num = shape_anim['step']
        eff_name = shape_anim['effect']
        eff_type = shape_anim['type']
        classes.extend(['neo-anim-target', f'neo-anim-step-{st_num}', f'neo-anim-{eff_name}', 'anim-hidden'])
        anim_attrs += f' data-anim-step="{st_num}" data-anim-type="{eff_type}" data-anim-effect="{eff_name}"'

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

        p_list = []
        raw_paras = list(text.get('paragraphs', []))
        while raw_paras and (raw_paras[-1].get('empty') or not any(r.get('text', '').strip() for r in raw_paras[-1].get('runs', []))):
            raw_paras = raw_paras[:-1]

        auto_counters = {}
        for p_idx, p in enumerate(raw_paras):
            b = p.get('bullet', '')
            auto_idx = 1
            if b and b.startswith('auto:'):
                b_key = (b, p.get('level', 0))
                auto_counters[b_key] = auto_counters.get(b_key, 0) + 1
                auto_idx = auto_counters[b_key]

            p_anim = para_anims.get((spid, p_idx))
            rendered_p = render_paragraph(p, slide_num, font_scale, p_idx, p_anim, auto_idx)
            if rendered_p:
                p_list.append(rendered_p)

        paragraphs_html = '\n'.join(p_list)
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        return f'<div class="{class_attr}" style="{style_attr}"{anim_attrs}>\n{paragraphs_html}\n</div>'
    else:
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        return f'<div class="{class_attr}" style="{style_attr}"{anim_attrs}></div>'

def build_slide_anim_map(slide_data):
    anims = slide_data.get('animations')
    if not anims or not anims.get('steps'):
        return {}, {}

    shape_anims = {}
    para_anims = {}

    for step_obj in anims['steps']:
        step_num = step_obj['step']
        for eff in step_obj.get('effects', []):
            target_spid = str(eff.get('spid', ''))
            p_range = eff.get('para_range')
            eff_type = eff.get('type', 'entr')
            eff_name = eff.get('effect', 'fade')
            dur_ms = eff.get('dur_ms', 400)

            matched = False
            for sh in slide_data.get('shapes', []):
                sh_id = str(sh.get('id', ''))
                grp_ids = [str(g) for g in sh.get('group_ids', [])]
                if sh_id == target_spid or target_spid in grp_ids:
                    matched = True
                    if p_range is not None:
                        st, end = p_range
                        for p_i in range(st, end + 1):
                            para_anims[(sh_id, p_i)] = {
                                'step': step_num,
                                'type': eff_type,
                                'effect': eff_name,
                                'dur_ms': dur_ms
                            }
                    else:
                        shape_anims[sh_id] = {
                            'step': step_num,
                            'type': eff_type,
                            'effect': eff_name,
                            'dur_ms': dur_ms
                        }
            if not matched:
                if p_range is not None:
                    st, end = p_range
                    for p_i in range(st, end + 1):
                        para_anims[(target_spid, p_i)] = {
                            'step': step_num,
                            'type': eff_type,
                            'effect': eff_name,
                            'dur_ms': dur_ms
                        }
                else:
                    shape_anims[target_spid] = {
                        'step': step_num,
                        'type': eff_type,
                        'effect': eff_name,
                        'dur_ms': dur_ms
                    }

    # Detect unanimated solid background/mask shapes that sit behind animated entrance groups/shapes
    # E.g. a solid white rectangle placed right behind an entrance box to cover underlying text when shown
    shapes = slide_data.get('shapes', [])
    for sh_idx, sh in enumerate(shapes):
        sh_id = str(sh.get('id', ''))
        if sh_id in shape_anims:
            continue
        fill = sh.get('fill') or {}
        has_text = bool(sh.get('text') and any(not p.get('empty') for p in sh.get('text', {}).get('paragraphs', [])))
        if fill.get('type') == 'solid' and not has_text:
            sx, sy, sw, sh_h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)
            if sw > 0 and sh_h > 0:
                # Look at subsequent shapes in z-order that are animated entrances
                for next_sh in shapes[sh_idx + 1:]:
                    next_id = str(next_sh.get('id', ''))
                    next_anim = shape_anims.get(next_id)
                    if next_anim and next_anim.get('type') == 'entr':
                        nx, ny, nw, nh = next_sh.get('x', 0), next_sh.get('y', 0), next_sh.get('w', 0), next_sh.get('h', 0)
                        # Check bounding overlap
                        overlap_x = max(0, min(sx + sw, nx + nw) - max(sx, nx))
                        overlap_y = max(0, min(sy + sh_h, ny + nh) - max(sy, ny))
                        overlap_area = overlap_x * overlap_y
                        next_area = nw * nh
                        if next_area > 0 and overlap_area / next_area > 0.6:
                            shape_anims[sh_id] = {
                                'step': next_anim['step'],
                                'type': next_anim['type'],
                                'effect': next_anim['effect'],
                                'dur_ms': next_anim['dur_ms']
                            }
                            break

    return shape_anims, para_anims

def build_slide_html(slide_data, layout_data, master_data, slide_index, slide_title):
    shape_anims, para_anims = build_slide_anim_map(slide_data)
    has_anims = bool(shape_anims or para_anims)

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
        rendered = render_shape(sh, slide_index, shape_anims, para_anims)
        if rendered:
            slide_elements.append(rendered)

    all_content = '\n    '.join(decor_elements + slide_elements)

    anim_script = ''
    if has_anims:
        anim_script = '''
  <script>
    (function() {
      var currentStep = 0;
      var targets = Array.prototype.slice.call(document.querySelectorAll('.neo-anim-target'));
      if (targets.length === 0) return;

      var steps = targets.map(function(el) { return parseInt(el.getAttribute('data-anim-step') || '0', 10); });
      var maxStep = Math.max.apply(Math, [0].concat(steps));

      function applyStep(step, animate) {
        currentStep = Math.max(0, Math.min(step, maxStep));
        for (var i = 0; i < targets.length; i++) {
          var el = targets[i];
          var elStep = parseInt(el.getAttribute('data-anim-step') || '0', 10);
          var elType = el.getAttribute('data-anim-type') || 'entr';
          if (elType === 'entr') {
            if (currentStep >= elStep) {
              el.classList.remove('anim-hidden');
              el.classList.add('anim-visible');
            } else {
              el.classList.add('anim-hidden');
              el.classList.remove('anim-visible');
            }
          } else if (elType === 'exit') {
            if (currentStep >= elStep) {
              el.classList.add('anim-hidden');
              el.classList.remove('anim-visible');
            } else {
              el.classList.remove('anim-hidden');
              el.classList.add('anim-visible');
            }
          }
        }
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'NEODECK_STEP_CHANGED',
              currentStep: currentStep,
              totalSteps: maxStep
            }, '*');
          }
        } catch (_) {}
      }

      window.goToAnimStep = function(step, animate) { applyStep(step, animate !== false); };
      window.nextAnimStep = function() {
        if (currentStep < maxStep) {
          applyStep(currentStep + 1, true);
          return true;
        }
        return false;
      };
      window.prevAnimStep = function() {
        if (currentStep > 0) {
          applyStep(currentStep - 1, true);
          return true;
        }
        return false;
      };
      window.getAnimState = function() {
        return { currentStep: currentStep, totalSteps: maxStep };
      };

      // Start at step 0 (initial hidden state for entrances)
      applyStep(0, false);

      window.addEventListener('message', function(e) {
        if (!e.data) return;
        if (e.data.type === 'NEODECK_SET_STEP') {
          applyStep(e.data.step, e.data.animate !== false);
        } else if (e.data.type === 'NEODECK_NEXT_STEP') {
          window.nextAnimStep();
        } else if (e.data.type === 'NEODECK_PREV_STEP') {
          window.prevAnimStep();
        } else if (e.data.type === 'NEODECK_SHOW_ALL') {
          document.body.classList.toggle('show-all-anims', !!e.data.showAll);
        }
      });
    })();
  </script>
'''

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
  <main class="slide slide-container">
    {all_content}
  </main>{anim_script}
</body>
</html>
'''
    return html_page

def generate_theme_css(data):
    canvas = data.get('canvas', {})
    cw = canvas.get('width', 1920)
    ch = canvas.get('height', 1080)

    colors = {}
    fonts = {}
    for m in data.get('masters', {}).values():
        t = m.get('theme', {})
        if t.get('colors'):
            colors.update(t['colors'])
        if t.get('fonts'):
            fonts.update(t['fonts'])

    dk1 = colors.get('dk1', '#111111')
    lt1 = colors.get('lt1', '#ffffff')
    dk2 = colors.get('dk2', '#333333')
    lt2 = colors.get('lt2', '#f5f5f5')
    acc1 = colors.get('accent1', '#3b82f6')
    acc2 = colors.get('accent2', '#10b981')
    acc3 = colors.get('accent3', '#f59e0b')
    acc4 = colors.get('accent4', '#ef4444')
    acc5 = colors.get('accent5', '#8b5cf6')
    acc6 = colors.get('accent6', '#06b6d4')

    heading_font = fonts.get('heading', 'Arial')
    body_font = fonts.get('body', 'Arial')

    return f"""/* Auto-generated Theme CSS from PowerPoint */
:root {{
  --slide-width: {cw}px;
  --slide-height: {ch}px;
  --slide-w: {cw}px;
  --slide-h: {ch}px;

  --color-primary: {acc1};
  --color-secondary: {acc2};
  --color-accent: {acc3};
  --color-bg: {lt1};
  --color-text: {dk1};

  --dk1: {dk1};
  --lt1: {lt1};
  --dk2: {dk2};
  --lt2: {lt2};
  --accent1: {acc1};
  --accent2: {acc2};
  --accent3: {acc3};
  --accent4: {acc4};
  --accent5: {acc5};
  --accent6: {acc6};

  --font-heading: "{heading_font}", system-ui, -apple-system, sans-serif;
  --font-body: "{body_font}", system-ui, -apple-system, sans-serif;
}}

* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{ width: {cw}px; height: {ch}px; overflow: hidden; }}
body {{ font-family: var(--font-body); color: var(--color-text); -webkit-font-smoothing: antialiased; }}

.slide, .slide-container {{
  position: relative;
  width: {cw}px;
  height: {ch}px;
  overflow: hidden;
  background-color: var(--color-bg);
}}

.abs {{ position: absolute; }}

.tb {{
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: visible;
  white-space: normal;
}}
.tb p {{ margin: 0; }}
.tb.anchor-t {{ justify-content: flex-start; }}
.tb.anchor-ctr {{ justify-content: center; }}
.tb.anchor-b {{ justify-content: flex-end; }}

.heading {{ font-family: var(--font-heading); }}
.bullet-list {{ list-style: none; }}
.bullet-list li {{ position: relative; }}

img.pic {{ position: absolute; object-fit: fill; display: block; }}

/* Animation Targets & Effects */
.neo-anim-target {{
  transition: opacity 0.35s ease, transform 0.35s ease, clip-path 0.35s ease;
}}

body:not(.show-all-anims):not(.edit-mode) .neo-anim-target.anim-hidden {{
  opacity: 0 !important;
  pointer-events: none !important;
  visibility: hidden !important;
}}

body:not(.show-all-anims):not(.edit-mode) .neo-anim-target.anim-hidden.neo-anim-wipe-down {{
  clip-path: inset(0 0 100% 0) !important;
  opacity: 0 !important;
}}
body:not(.show-all-anims):not(.edit-mode) .neo-anim-target.anim-hidden.neo-anim-wipe-up {{
  clip-path: inset(100% 0 0 0) !important;
  opacity: 0 !important;
}}
body:not(.show-all-anims):not(.edit-mode) .neo-anim-target.anim-hidden.neo-anim-wipe-left {{
  clip-path: inset(0 0 0 100%) !important;
  opacity: 0 !important;
}}
body:not(.show-all-anims):not(.edit-mode) .neo-anim-target.anim-hidden.neo-anim-wipe-right {{
  clip-path: inset(0 100% 0 0) !important;
  opacity: 0 !important;
}}

.neo-anim-target.anim-visible,
body.show-all-anims .neo-anim-target,
body.edit-mode .neo-anim-target {{
  opacity: 1 !important;
  visibility: visible !important;
  clip-path: inset(0 0 0 0) !important;
}}
"""

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

    # Setup assets directory and copy media
    assets_dir = os.path.join(out_dir, 'assets')
    os.makedirs(assets_dir, exist_ok=True)

    extract_media_dir = os.path.join(os.path.dirname(extract_path), 'media')
    if os.path.isdir(extract_media_dir):
        dest_media_dir = os.path.join(assets_dir, 'media')
        os.makedirs(dest_media_dir, exist_ok=True)
        import shutil
        for item in os.listdir(extract_media_dir):
            s_item = os.path.join(extract_media_dir, item)
            d_item = os.path.join(dest_media_dir, item)
            if os.path.isfile(s_item):
                shutil.copy2(s_item, d_item)

    # Write assets/theme.css
    theme_css_content = generate_theme_css(data)
    with open(os.path.join(assets_dir, 'theme.css'), 'w') as tf:
        tf.write(theme_css_content)

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
        if s.get('number') == 1 and not slide_title.strip():
            slide_title = 'Title Slide'

        folder_name = f'{active_idx:02d}-{slugify(slide_title)}'
        slide_dir = os.path.join(out_dir, 'slides', folder_name)
        os.makedirs(slide_dir, exist_ok=True)

        slide_html = build_slide_html(s, layout, master, active_idx, slide_title)
        with open(os.path.join(slide_dir, 'index.html'), 'w') as sf:
            sf.write(slide_html)

        rel_path = f'slides/{folder_name}/index.html'
        notes = (s.get('notes') or '').strip()

        slide_entry = {
            'id': f'slide-{active_idx}',
            'title': slide_title,
            'path': rel_path,
            'notes': notes,
            'transition': 'fade'
        }
        if s.get('animations') and s['animations'].get('total_steps', 0) > 0:
            slide_entry['hasAnimations'] = True
            slide_entry['animationSteps'] = s['animations']['total_steps']

        manifest_slides.append(slide_entry)

        print(f'Generated slide {active_idx:02d} (orig {s.get("number")}): {slide_title} -> {rel_path}')
        active_idx += 1

    deck_title = manifest_slides[0]['title'] if manifest_slides else 'Presentation'
    if data.get('source'):
        src_clean = os.path.splitext(os.path.basename(data['source']))[0].replace('_', ' ')
        if manifest_slides and manifest_slides[0]['title'] not in ('Slide 1', ''):
            deck_title = manifest_slides[0]['title']
        else:
            deck_title = src_clean

    canvas = data.get('canvas', {})
    cw = canvas.get('width', 1920)
    ch = canvas.get('height', 1080)

    # Write deck.json
    deck_json = {
        'version': '1.0.0',
        'title': deck_title,
        'aspectRatio': '16:9',
        'customWidth': cw,
        'customHeight': ch,
        'theme': 'dark',
        'defaultTransition': 'fade',
        'slides': manifest_slides
    }

    with open(os.path.join(out_dir, 'deck.json'), 'w') as df:
        json.dump(deck_json, df, indent=2)

    print(f'\nWrote deck.json with {len(manifest_slides)} slides to {out_dir}/deck.json')

if __name__ == '__main__':
    main()
