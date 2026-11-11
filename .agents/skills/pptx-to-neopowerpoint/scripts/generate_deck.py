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
    if line.get('dash') in ('dash', 'dashDot', 'lgDash', 'sysDash'):
        dash = 'dashed'
    elif line.get('dash') in ('dot', 'sysDot'):
        dash = 'dotted'
    return f'border: {w:.1f}px {dash} {col};'


# ---------------------------------------------------------------------------
# Fonts: metric-compatible stacks + bundled WOFF2 assets
# ---------------------------------------------------------------------------
FONT_STACKS = {
    'calibri': "'Calibri', 'Carlito', 'Liberation Sans', Arial, sans-serif",
    'calibri light': "'Calibri Light', 'Calibri', 'Carlito', 'Liberation Sans', sans-serif",
    'arial': "Arial, 'Liberation Sans', 'Arimo', Helvetica, sans-serif",
    'helvetica': "Helvetica, Arial, 'Liberation Sans', sans-serif",
    'times new roman': "'Times New Roman', 'Liberation Serif', 'Tinos', Times, serif",
    'times': "Times, 'Times New Roman', 'Liberation Serif', 'Tinos', serif",
    'courier new': "'Courier New', 'Liberation Mono', 'Cousine', Courier, monospace",
    'cambria': "Cambria, 'Caladea', 'Liberation Serif', Georgia, serif",
    'consolas': "Consolas, 'Liberation Mono', 'Fira Code', monospace",
    'tahoma': "Tahoma, 'Liberation Sans', Geneva, sans-serif",
    'verdana': "Verdana, 'Liberation Sans', Geneva, sans-serif",
    'gill sans mt': "'Gill Sans MT', 'Gill Sans', 'Liberation Sans', sans-serif",
    'georgia': "Georgia, 'Liberation Serif', 'Caladea', serif",
}

# family name -> (bundled family, filename stem)
BUNDLED_FONTS = {
    'calibri': ('Carlito', 'Carlito'),
    'calibri light': ('Carlito', 'Carlito'),
    'cambria': ('Caladea', 'Caladea'),
    'arial': ('Liberation Sans', 'LiberationSans'),
    'helvetica': ('Liberation Sans', 'LiberationSans'),
    'tahoma': ('Liberation Sans', 'LiberationSans'),
    'verdana': ('Liberation Sans', 'LiberationSans'),
    'times new roman': ('Liberation Serif', 'LiberationSerif'),
    'times': ('Liberation Serif', 'LiberationSerif'),
    'georgia': ('Liberation Serif', 'LiberationSerif'),
    'courier new': ('Liberation Mono', 'LiberationMono'),
    'consolas': ('Liberation Mono', 'LiberationMono'),
}
FONT_STYLES = (('Regular', 400, 'normal'), ('Bold', 700, 'normal'),
               ('Italic', 400, 'italic'), ('BoldItalic', 700, 'italic'))


def collect_used_fonts(data):
    fonts = set()

    def add(name):
        if name:
            fonts.add(str(name).strip().lower())

    for m in data.get('masters', {}).values():
        t = m.get('theme', {})
        fs = t.get('fonts') or {}
        add(fs.get('heading')); add(fs.get('body'))

    def scan_text(text):
        if not text:
            return
        for para in text.get('paragraphs', []):
            for run in para.get('runs', []):
                add(run.get('font'))
            add((para.get('style') or {}).get('font'))

    for coll in ('slides',):
        for sl in data.get(coll, []):
            for sh in sl.get('shapes', []):
                scan_text(sh.get('text'))
                for row in (sh.get('table') or {}).get('rows', []):
                    for cell in row.get('cells', []):
                        scan_text(cell.get('text'))
    return fonts


def copy_bundled_fonts(data, assets_dir, script_dir):
    """Copy only the metric-compatible WOFF2 files this deck actually needs."""
    used = collect_used_fonts(data)
    stems = {BUNDLED_FONTS[f][1] for f in used if f in BUNDLED_FONTS}
    if not stems:
        return
    src_dir = os.path.join(script_dir, 'fonts')
    dst_dir = os.path.join(assets_dir, 'fonts')
    os.makedirs(dst_dir, exist_ok=True)
    import shutil
    for stem in sorted(stems):
        for style_name, _weight, _style in FONT_STYLES:
            fn = f'{stem}-{style_name}.woff2'
            src = os.path.join(src_dir, fn)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(dst_dir, fn))


def resolve_font_stack(font):
    if not font:
        return None
    return FONT_STACKS.get(font.strip().lower(),
                           "'%s', system-ui, -apple-system, sans-serif" % font.replace("'", '').replace('"', ''))


def bundled_font_css(used_fonts):
    """Emit @font-face rules that prefer real PowerPoint fonts, then bundled metrics."""
    display_names = {
        'calibri': 'Calibri', 'calibri light': 'Calibri Light', 'cambria': 'Cambria',
        'arial': 'Arial', 'helvetica': 'Helvetica', 'tahoma': 'Tahoma',
        'verdana': 'Verdana', 'times new roman': 'Times New Roman', 'times': 'Times',
        'georgia': 'Georgia', 'courier new': 'Courier New', 'consolas': 'Consolas',
    }
    rules, emitted = [], set()
    for name in sorted(used_fonts):
        spec = BUNDLED_FONTS.get(name)
        if not spec:
            continue
        family, stem = spec
        display = display_names.get(name, family)
        if display in emitted:
            continue
        emitted.add(display)
        for style_name, weight, style in FONT_STYLES:
            rules.append(
                "@font-face {\n"
                f"  font-family: '{display}';\n"
                f"  src: local('{display}'), local('{family} {style_name}'), "
                f"url('./fonts/{stem}-{style_name}.woff2') format('woff2');\n"
                f"  font-weight: {weight};\n  font-style: {style};\n  font-display: swap;\n}}")
    return '\n'.join(rules)


# ---------------------------------------------------------------------------
# SVG rendering helpers (lines, markers, preset geometries)
# ---------------------------------------------------------------------------
DASH_ARRAYS = {
    'dot': '{lw:g},{lw2:g}',
    'sysDot': '{lw:g},{lw2:g}',
    'sysDash': '{lw3:g},{lw15:g}',
    'dash': '{lw4:g},{lw3:g}',
    'lgDash': '{lw8:g},{lw3:g}',
    'dashDot': '{lw4:g},{lw2:g},{lw:g},{lw2:g}',
    'lgDashDot': '{lw8:g},{lw2:g},{lw:g},{lw2:g}',
    'lgDashDotDot': '{lw8:g},{lw2:g},{lw:g},{lw2:g},{lw:g},{lw2:g}',
}


def dash_attr(dash, lw):
    pat = DASH_ARRAYS.get(dash)
    if not pat:
        return ''
    return ' stroke-dasharray="%s"' % pat.format(lw=lw, lw2=lw * 2, lw15=lw * 1.5,
                                                  lw3=lw * 3, lw4=lw * 4, lw8=lw * 8)


ARROW_SCALE = {'sm': 3.0, 'med': 4.8, 'lg': 7.0}


def arrow_dims(line, end):
    data = line.get(end) if line else None
    if not data:
        return None
    lw = max(1.0, line.get('width_px', 1.0))
    L = max(5.0, lw * ARROW_SCALE.get(data.get('len', 'med'), 3.6))
    return L, L * 0.72


def arrow_marker_def(mid, kind, L, W, color):
    if kind == 'triangle':
        body = f'<path d="M 0 0 L {L:.2f} {W / 2:.2f} L 0 {W:.2f} z" fill="{color}"/>'
    elif kind == 'stealth':
        body = (f'<path d="M 0 0 L {L:.2f} {W / 2:.2f} L 0 {W:.2f} '
                f'L {L * 0.55:.2f} {W / 2:.2f} z" fill="{color}"/>')
    elif kind == 'arrow':
        body = (f'<path d="M 0.8 0.8 L {L:.2f} {W / 2:.2f} L 0.8 {W - 0.8:.2f}" '
                f'fill="none" stroke="{color}" stroke-width="{max(1.0, W * 0.16):.2f}" '
                'stroke-linecap="round" stroke-linejoin="round"/>')
    elif kind == 'diamond':
        body = (f'<path d="M 0 {W / 2:.2f} L {L / 2:.2f} 0 L {L:.2f} {W / 2:.2f} '
                f'L {L / 2:.2f} {W:.2f} z" fill="{color}"/>')
    elif kind == 'oval':
        body = (f'<ellipse cx="{L / 2:.2f}" cy="{W / 2:.2f}" rx="{L / 2:.2f}" '
                f'ry="{W / 2:.2f}" fill="{color}"/>')
    else:
        return None
    return (f'<marker id="{mid}" markerUnits="userSpaceOnUse" markerWidth="{L:.2f}" '
            f'markerHeight="{W:.2f}" refX="{L:.2f}" refY="{W / 2:.2f}" '
            f'orient="auto-start-reverse" viewBox="0 0 {L:.2f} {W:.2f}">{body}</marker>')


def adj_value(sh, name, default):
    adj = sh.get('geometry_adjust') or {}
    raw = adj.get(name)
    try:
        return float(raw if raw is not None else default) / 100000.0
    except (TypeError, ValueError):
        return default / 100000.0


def connector_points(sh):
    """Return OOXML-ish waypoints for straight/bent/curved connectors (before flips)."""
    w, h = sh.get('w', 0.0), sh.get('h', 0.0)
    geom = sh.get('geometry') or 'straightConnector1'
    if geom in ('line', 'straightConnector1', 'straightConnector2', 'straightConnector3',
                'straightConnector4', 'straightConnector5'):
        return [(0.0, 0.0), (w, h)]
    if geom == 'bentConnector2':
        return [(0.0, 0.0), (w, 0.0), (w, h)]
    if geom == 'bentConnector3':
        a = adj_value(sh, 'adj1', 50000)
        return [(0.0, 0.0), (w * a, 0.0), (w * a, h), (w, h)]
    if geom == 'bentConnector4':
        a1 = adj_value(sh, 'adj1', 50000)
        a2 = adj_value(sh, 'adj2', 50000)
        return [(0.0, 0.0), (w, 0.0), (w, h * a2), (w * a1, h * a2), (w * a1, h)]
    if geom == 'bentConnector5':
        a1 = adj_value(sh, 'adj1', 50000)
        a2 = adj_value(sh, 'adj2', 50000)
        return [(0.0, 0.0), (w * a1, 0.0), (w * a1, h * a2),
                (w, h * a2), (w, h)]
    if geom in ('curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5'):
        return None  # rendered as a cubic path
    return [(0.0, 0.0), (w, h)]


def connector_render(sh, line, uid, anim_attrs, anim_classes):
    """Render a connector as an SVG with direction-aware markers and dashes."""
    w, h = sh.get('w', 0.0), sh.get('h', 0.0)
    x, y = sh.get('x', 0.0), sh.get('y', 0.0)
    rot = sh.get('rotation_deg') or 0
    flip_h = bool(sh.get('flipH'))
    flip_v = bool(sh.get('flipV'))
    geom = sh.get('geometry') or 'straightConnector1'
    col = line.get('color', '#ffffff')
    lw = max(1.0, line.get('width_px', 1.0))
    dash = dash_attr(line.get('dash'), lw)

    defs, markers = [], []
    head_dims, tail_dims = arrow_dims(line, 'head'), arrow_dims(line, 'tail')
    if line.get('tail'):
        d = arrow_marker_def(f'{uid}_tail', line['tail'].get('type'), tail_dims[0], tail_dims[1], col)
        if d:
            defs.append(d)
            markers.append(f'marker-end="url(#{uid}_tail)"')
    if line.get('head'):
        d = arrow_marker_def(f'{uid}_head', line['head'].get('type'), head_dims[0], head_dims[1], col)
        if d:
            defs.append(d)
            markers.append(f'marker-start="url(#{uid}_head)"')

    transforms = []
    if rot:
        transforms.append(f'rotate({rot:.2f}deg)')
    transform_css = f'transform: {" ".join(transforms)}; transform-origin: 50% 50%;' if transforms else ''
    defs_html = ('<defs>' + ''.join(defs) + '</defs>') if defs else ''
    marker_attr = (' ' + ' '.join(markers)) if markers else ''
    vw, vh = max(w, 1.0), max(h, 1.0)

    def fx(px):
        return w - px if flip_h else px

    def fy(py):
        return h - py if flip_v else py

    if geom.startswith('curvedConnector'):
        a = adj_value(sh, 'adj1', 50000)
        if geom == 'curvedConnector2':
            d = f'M {fx(0):g} {fy(0):g} C {fx(0):g} {fy(h * 0.55):g} {fx(w * 0.45):g} {fy(h):g} {fx(w):g} {fy(h):g}'
        elif geom == 'curvedConnector3':
            d = (f'M {fx(0):g} {fy(0):g} C {fx(w * a):g} {fy(0):g} '
                 f'{fx(w * a):g} {fy(h):g} {fx(w):g} {fy(h):g}')
        else:
            d = (f'M {fx(0):g} {fy(0):g} C {fx(0):g} {fy(h * 0.55):g} '
                 f'{fx(w * 0.45):g} {fy(h):g} {fx(w):g} {fy(h):g}')
        return (f'<svg class="abs {anim_classes}" viewBox="0 0 {vw:g} {vh:g}" '
                f'style="left:{x:.1f}px;top:{y:.1f}px;width:{vw:g}px;height:{vh:g}px;'
                f'overflow:visible;{transform_css}"{anim_attrs}>{defs_html}'
                f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{lw:g}"{dash}{marker_attr}/></svg>')

    pts = connector_points(sh)
    # Keep the true OOXML endpoint: the marker tip lands exactly there (refX=L).
    pts = [(fx(px), fy(py)) for px, py in pts]
    if len(pts) == 2:
        (x1, y1), (x2, y2) = pts
        shape = (f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" '
                 f'stroke="{col}" stroke-width="{lw:g}" stroke-linecap="round"{dash}{marker_attr}/>')
    else:
        d = 'M ' + ' L '.join(f'{px:.2f} {py:.2f}' for px, py in pts)
        shape = (f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{lw:g}" '
                 f'stroke-linejoin="round"{dash}{marker_attr}/>')
    return (f'<svg class="abs {anim_classes}" viewBox="0 0 {vw:g} {vh:g}" '
            f'style="left:{x:.1f}px;top:{y:.1f}px;width:{vw:g}px;height:{vh:g}px;'
            f'overflow:visible;{transform_css}"{anim_attrs}>{defs_html}{shape}</svg>')


def svg_gradient_def(gid, fill):
    """Build an SVG <linearGradient> definition from an OOXML gradient fill."""
    import math
    stops = (fill or {}).get('stops') or []
    if not stops:
        return None
    ang_deg = (fill or {}).get('angle_deg', 0.0) or 0.0
    ang_rad = math.radians(ang_deg)
    dx, dy = math.cos(ang_rad), math.sin(ang_rad)
    scale = max(abs(dx), abs(dy), 1e-6)
    x1, y1 = 0.5 - 0.5 * dx / scale, 0.5 - 0.5 * dy / scale
    x2, y2 = 0.5 + 0.5 * dx / scale, 0.5 + 0.5 * dy / scale
    stop_html = ''.join(
        f'<stop offset="{s.get("pos", 0)}%" stop-color="{s.get("color", "#000")}"/>'
        for s in stops)
    return (f'<linearGradient id="{gid}" x1="{x1:.3f}" y1="{y1:.3f}" '
            f'x2="{x2:.3f}" y2="{y2:.3f}">{stop_html}</linearGradient>')


def scale_cust_path(d, sx, sy):
    """Scale an SVG path emitted by cust_geom_path from (pw, ph) to (w, h) px."""
    if not d or (abs(sx - 1.0) < 1e-6 and abs(sy - 1.0) < 1e-6):
        return d
    toks = d.replace(',', ' ').split()
    out = []
    i = 0
    cmd = None
    while i < len(toks):
        t = toks[i]
        if t in ('M', 'L', 'C', 'Q', 'A', 'Z'):
            cmd = t
            out.append(t)
            i += 1
            continue
        if cmd in ('M', 'L', 'C', 'Q') and i + 1 < len(toks):
            out.append(f'{float(toks[i]) * sx:g} {float(toks[i + 1]) * sy:g}')
            i += 2
        elif cmd == 'A' and i + 6 < len(toks):
            rx = float(toks[i]) * sx
            ry = float(toks[i + 1]) * sy
            xrot, large, sweep = toks[i + 2], toks[i + 3], toks[i + 4]
            ex = float(toks[i + 5]) * sx
            ey = float(toks[i + 6]) * sy
            out.append(f'{rx:g} {ry:g} {xrot} {large} {sweep} {ex:g} {ey:g}')
            i += 7
        else:
            out.append(t)
            i += 1
    return ' '.join(out)


def preset_shape_svg(geom, w, h, sh, fill, line, uid, inset=False, extra_transform=''):
    """Build SVG markup for OOXML preset geometries that are not rectangles."""
    fill_col = 'none'
    defs = []
    if fill and fill.get('type') == 'solid':
        fill_col = fill.get('color', 'none')
    elif fill and fill.get('type') == 'gradient':
        gid = f'grad_{uid}'
        gdef = svg_gradient_def(gid, fill)
        if gdef:
            defs.append(gdef)
            fill_col = f'url(#{gid})'
    line_col = line.get('color', 'none') if line else 'none'
    lw = max(1.0, line.get('width_px', 1.0)) if line else 0.0
    stroke = f' stroke="{line_col}" stroke-width="{lw:g}"' if line else ''
    if line:
        stroke += dash_attr(line.get('dash'), lw)
    common = f'fill="{fill_col}"{stroke}'

    a1 = adj_value(sh, 'adj1', 50000)
    a2 = adj_value(sh, 'adj2', 50000)
    mn = min(w, h)

    def pts(points):
        return ' '.join(f'{px:.2f},{py:.2f}' for px, py in points)

    if geom in ('rightArrow', 'notchedRightArrow'):
        L = min(w, max(0.0, mn * a2))
        bh = h * max(0.05, min(1.0, a1))
        top, bot = (h - bh) / 2, (h + bh) / 2
        if geom == 'notchedRightArrow':
            notch = L * 0.28
            p = [(0, 0), (w - L, 0), (w, h / 2), (w - L, h), (0, h), (notch, h / 2)]
        else:
            p = [(0, top), (w - L, top), (w - L, 0), (w, h / 2), (w - L, h), (w - L, bot), (0, bot)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'leftArrow':
        L = min(w, max(0.0, mn * a2))
        bh = h * max(0.05, min(1.0, a1))
        top, bot = (h - bh) / 2, (h + bh) / 2
        p = [(w, top), (L, top), (L, 0), (0, h / 2), (L, h), (L, bot), (w, bot)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'upArrow':
        L = min(h, max(0.0, mn * a2))
        bw = w * max(0.05, min(1.0, a1))
        left, right = (w - bw) / 2, (w + bw) / 2
        p = [(left, h), (left, L), (0, L), (w / 2, 0), (w, L), (right, L), (right, h)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'downArrow':
        L = min(h, max(0.0, mn * a2))
        bw = w * max(0.05, min(1.0, a1))
        left, right = (w - bw) / 2, (w + bw) / 2
        p = [(left, 0), (left, h - L), (0, h - L), (w / 2, h), (w, h - L), (right, h - L), (right, 0)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'leftRightArrow':
        L = min(w / 2, max(0.0, mn * a2))
        bh = h * max(0.05, min(1.0, a1))
        top, bot = (h - bh) / 2, (h + bh) / 2
        p = [(0, h / 2), (L, 0), (L, top), (w - L, top), (w - L, 0), (w, h / 2),
             (w - L, h), (w - L, bot), (L, bot), (L, h)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'upDownArrow':
        L = min(h / 2, max(0.0, mn * a2))
        bw = w * max(0.05, min(1.0, a1))
        left, right = (w - bw) / 2, (w + bw) / 2
        p = [(w / 2, 0), (w, L), (right, L), (right, h - L), (w, h - L),
             (w / 2, h), (0, h - L), (left, h - L), (left, L), (0, L)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'chevron':
        L = min(w / 2, max(0.0, mn * a1))
        p = [(0, 0), (w - L, 0), (w, h / 2), (w - L, h), (0, h), (L, h / 2)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'homePlate':
        L = min(w, max(0.0, mn * a1))
        p = [(0, 0), (w - L, 0), (w, h / 2), (w - L, h), (0, h)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'pentagon':
        body = f'<polygon points="{pts([(w / 2, 0), (w, h * 0.38), (w * 0.82, h), (w * 0.18, h), (0, h * 0.38)])}" {common}/>'
    elif geom == 'hexagon':
        ins = min(w / 2, mn * a1)
        body = f'<polygon points="{pts([(ins, 0), (w - ins, 0), (w, h / 2), (w - ins, h), (ins, h), (0, h / 2)])}" {common}/>'
    elif geom == 'octagon':
        ix, iy = min(w / 2, mn * a1), min(h / 2, mn * a1)
        body = f'<polygon points="{pts([(ix, 0), (w - ix, 0), (w, iy), (w, h - iy), (w - ix, h), (ix, h), (0, h - iy), (0, iy)])}" {common}/>'
    elif geom == 'plus':
        ix, iy = min(w / 2, mn * a1), min(h / 2, mn * a1)
        p = [(ix, 0), (w - ix, 0), (w - ix, iy), (w, iy), (w, h - iy), (w - ix, h - iy),
             (w - ix, h), (ix, h), (ix, h - iy), (0, h - iy), (0, iy), (ix, iy)]
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom == 'diamond':
        body = f'<polygon points="{pts([(w / 2, 0), (w, h / 2), (w / 2, h), (0, h / 2)])}" {common}/>'
    elif geom == 'triangle':
        body = f'<polygon points="{pts([(w / 2, 0), (w, h), (0, h)])}" {common}/>'
    elif geom == 'rtTriangle':
        body = f'<polygon points="{pts([(0, 0), (0, h), (w, h)])}" {common}/>'
    elif geom == 'parallelogram':
        sk = min(w / 2, mn * a1)
        body = f'<polygon points="{pts([(sk, 0), (w, 0), (w - sk, h), (0, h)])}" {common}/>'
    elif geom == 'trapezoid':
        ins = min(w / 2, mn * a1)
        body = f'<polygon points="{pts([(ins, 0), (w - ins, 0), (w, h), (0, h)])}" {common}/>'
    elif geom == 'star5':
        import math
        cx, cy, R = w / 2, h / 2, mn / 2
        p = []
        for i in range(10):
            ang = math.radians(-90 + i * 36)
            r = R if i % 2 == 0 else R * 0.382
            p.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
        body = f'<polygon points="{pts(p)}" {common}/>'
    elif geom in ('wedgeRectCallout', 'wedgeRoundRectCallout'):
        # Approximate: rounded/rect body plus a pointer at the bottom-left.
        tx, ty = w * (0.5 + (sh.get('geometry_adjust') or {}).get('adj1', -20833) / 100000.0), h * (0.5 + (sh.get('geometry_adjust') or {}).get('adj2', 62500) / 100000.0)
        tx = max(0, min(w, tx)); ty = max(0, min(h, ty))
        if geom == 'wedgeRoundRectCallout':
            body = (f'<path d="M 0 {h * 0.18:.2f} Q 0 0 {w * 0.1:.2f} 0 L {w * 0.9:.2f} 0 '
                    f'Q {w:.2f} 0 {w:.2f} {h * 0.18:.2f} L {w:.2f} {h * 0.82:.2f} '
                    f'Q {w:.2f} {h:.2f} {w * 0.9:.2f} {h:.2f} L {w * 0.45:.2f} {h:.2f} '
                    f'L {tx:.2f} {ty:.2f} L {w * 0.25:.2f} {h:.2f} L {w * 0.1:.2f} {h:.2f} '
                    f'Q 0 {h:.2f} 0 {h * 0.82:.2f} Z" {common}/>')
        else:
            body = (f'<path d="M 0 0 L {w:.2f} 0 L {w:.2f} {h:.2f} L {w * 0.45:.2f} {h:.2f} '
                    f'L {tx:.2f} {ty:.2f} L {w * 0.25:.2f} {h:.2f} L 0 {h:.2f} Z" {common}/>')
    elif geom in ('leftBrace', 'rightBrace', 'leftBracket', 'rightBracket'):
        if 'Bracket' in geom:
            x0 = w * 0.7 if geom == 'leftBracket' else w * 0.3
            d = f'M {x0:.2f} 0 L {x0:.2f} {h:.2f}'
        else:
            x0 = w * 0.15 if geom == 'leftBrace' else w * 0.85
            xm = w * 0.5 if geom == 'leftBrace' else w * 0.5
            d = (f'M {w if geom == "leftBrace" else 0:.2f} 0 C {x0:.2f} 0 {x0:.2f} {h * 0.25:.2f} '
                 f'{xm:.2f} {h * 0.28:.2f} L {xm:.2f} {h * 0.28:.2f} C {x0:.2f} {h * 0.33:.2f} '
                 f'{x0:.2f} {h * 0.42:.2f} {x0:.2f} {h * 0.5:.2f} C {x0:.2f} {h * 0.58:.2f} '
                 f'{x0:.2f} {h * 0.67:.2f} {xm:.2f} {h * 0.72:.2f} C {x0:.2f} {h * 0.75:.2f} '
                 f'{x0:.2f} {h:.2f} {w if geom == "leftBrace" else 0:.2f} {h:.2f}')
        body = f'<path d="{d}" fill="none" stroke="{line_col}" stroke-width="{lw or 2:g}"/>'
    elif geom in ('flowChartDecision',):
        body = f'<polygon points="{pts([(w / 2, 0), (w, h / 2), (w / 2, h), (0, h / 2)])}" {common}/>'
    elif geom in ('flowChartTerminator',):
        r = min(w, h) / 2
        body = f'<rect x="0" y="0" width="{w:.2f}" height="{h:.2f}" rx="{r:.2f}" {common}/>'
    elif geom in ('ellipse',):
        body = f'<ellipse cx="{w / 2:.2f}" cy="{h / 2:.2f}" rx="{w / 2:.2f}" ry="{h / 2:.2f}" {common}/>'
    else:
        return None
    defs_html = ('<defs>' + ''.join(defs) + '</defs>') if defs else ''
    style = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;' if inset else ''
    if extra_transform:
        style += extra_transform
    return (f'<svg class="preset-svg" viewBox="0 0 {max(w, 1):g} {max(h, 1):g}" '
            f'preserveAspectRatio="none" style="{style}">{defs_html}{body}</svg>')

def render_run(run, slide_num, font_scale=1.0, tab_stops=None):
    if run.get('tab'):
        width = 40.0
        if tab_stops:
            width = max(12.0, tab_stops[0])
        return f'<span class="neo-tab" style="display: inline-block; min-width: {width:.1f}px;">&nbsp;</span>'
    text = run.get('text', '')
    if run.get('field') == 'slidenum' or text == '‹#›':
        text = str(slide_num)
    
    if not text:
        return ''

    styles = []
    font = run.get('font')
    if font:
        lowered = font.lower()
        if 'castoro' in lowered or 'georgia' in lowered:
            styles.append('font-family: var(--font-heading);')
        elif 'nunito sans' in lowered:
            styles.append('font-family: var(--font-body);')
        elif 'aptos' in lowered:
            styles.append('font-family: var(--font-sans);')
        else:
            styles.append(f'font-family: {resolve_font_stack(font)};')

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
    if run.get('underline'):
        styles.append('text-decoration: underline;')
    if run.get('strike'):
        styles.append('text-decoration: line-through;')
    if run.get('uppercase'):
        styles.append('text-transform: uppercase;')
    
    baseline = run.get('baseline', 0)
    if baseline < 0:
        styles.append('vertical-align: sub; font-size: 0.65em; line-height: 0; position: relative;')
    elif baseline > 0:
        styles.append('vertical-align: super; font-size: 0.65em; line-height: 0; position: relative;')

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

def render_paragraph(p, slide_num, font_scale=1.0, p_idx=None, para_anim=None, auto_idx=1, ln_reduction=0.0, first=False):
    p_styles = []
    p_classes = []
    anim_attrs = ''

    if para_anim:
        cls, anim_attrs = anim_markup(para_anim, '', p_idx)
        p_classes.extend(cls.split())
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

    # Effective paragraph font size (used for percentage spacing / empty lines)
    first_run = p.get('runs', [{}])[0] if p.get('runs') else {}
    para_font_px = first_run.get('size_px') or p.get('style', {}).get('size_px') or 24.0
    para_font_px *= font_scale

    reduction = max(0.0, min(90.0, ln_reduction)) / 100.0
    ln_spc = p.get('line_spacing')
    if ln_spc:
        if 'percent' in ln_spc:
            # 100% single spacing in DrawingML maps to ~1.2 CSS em.
            p_styles.append(f'line-height: {ln_spc["percent"] / 100 * 1.2 * (1.0 - reduction):.3f};')
        elif 'px' in ln_spc:
            p_styles.append(f'line-height: {ln_spc["px"] * (1.0 - reduction):.1f}px;')
    else:
        p_styles.append(f'line-height: {1.2 * (1.0 - reduction):.3f};')

    sb = p.get('space_before') or {}
    sa = p.get('space_after') or {}
    # Renderers (and OOXML layout engines) discard top spacing at the very start
    # of a text body; applying it pushed every first line down by 10-30px.
    if (sb.get('px') or sb.get('percent')) and not first:
        mt = sb.get('px') or (sb.get('percent', 0) / 100.0) * para_font_px * 1.2
        if mt:
            p_styles.append(f'margin-top: {mt:.1f}px;')
    if sa.get('px') or sa.get('percent'):
        mb = sa.get('px') or (sa.get('percent', 0) / 100.0) * para_font_px * 1.2
        if mb:
            p_styles.append(f'margin-bottom: {mb:.1f}px;')

    runs_html = ''.join(render_run(r, slide_num, font_scale, p.get('tab_stops')) for r in p.get('runs', []))
    class_attr = f' class="{" ".join(p_classes)}"' if p_classes else ''

    if p.get('empty') or not runs_html.strip():
        empty_sz = para_font_px
        p_styles.append(f'min-height: {empty_sz:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        return f'<p{class_attr}{style_attr}{anim_attrs}><span style="font-size: {empty_sz:.1f}px;">&nbsp;</span></p>'

    bullet = p.get('bullet')
    mar_l = p.get('marL', 0)
    indent = p.get('indent', 0)

    if bullet:
        bullet_text = format_bullet_str(bullet, auto_idx)
        bullet_char = html.escape(bullet_text)
        bullet_sz = para_font_px
        if p.get('bu_sz_px'):
            bullet_sz = p['bu_sz_px'] * font_scale
        elif p.get('bu_sz_pct'):
            bullet_sz = para_font_px * p['bu_sz_pct'] / 100.0
        # OOXML hanging indent: the bullet is drawn at marL+indent, while the
        # paragraph text starts at marL.  Padding the text by the bullet's font
        # size (the old behaviour) shifted labels ~50px to the right.
        bullet_left = max(0.0, mar_l + indent)
        text_pad = max(0.0, mar_l, bullet_left)
        p_styles.append(f'position: relative; padding-left: {text_pad:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        bullet_col = p.get('bullet_color') or first_run.get('color', 'inherit')
        bullet_span = (f'<span style="position: absolute; left: {bullet_left:.1f}px; top: 0; '
                       f'font-size: {bullet_sz:.1f}px; color: {bullet_col}; '
                       f'line-height: inherit; user-select: none;">{bullet_char}</span>')
        return f'<p{class_attr}{style_attr}{anim_attrs}>{bullet_span}{runs_html}</p>'
    else:
        # No bullet: the first line is still positioned at marL + indent
        # (OOXML first-line indent), subsequent lines at marL.
        if mar_l > 0:
            p_styles.append(f'padding-left: {mar_l:.1f}px;')
        if indent:
            p_styles.append(f'text-indent: {indent:.1f}px;')
        style_attr = f' style="{" ".join(p_styles)}"' if p_styles else ''
        return f'<p{class_attr}{style_attr}{anim_attrs}>{runs_html}</p>'

def render_table(sh, slide_num, shape_anim=None):
    tbl = sh.get('table', {})
    cols = tbl.get('column_widths_px', [])
    rows = tbl.get('rows', [])
    x, y, w, h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)
    spid = str(sh.get('id') or sh.get('spid') or '')

    tbl_classes = ['slide-table']
    cls, anim_attrs = anim_markup(shape_anim, spid)
    if cls:
        tbl_classes.extend(cls.split())

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
    shape_anim_classes, shape_anim_attrs = anim_markup(shape_anim, spid)

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

        anim_classes = (' ' + shape_anim_classes) if shape_anim_classes else ''
        anim_attrs = shape_anim_attrs

        if crop:
            # OOXML <a:srcRect> crops the source bitmap; the remaining source
            # rectangle is stretched to the shape box (<a:stretch><a:fillRect/>).
            # Negative values extend past the bitmap and are clamped here.
            def _pct(key):
                return min(0.95, max(0.0, float(crop.get(key, 0)) / 100.0))
            cl, ct, cr, cb = _pct('l'), _pct('t'), _pct('r'), _pct('b')
            vis_w = max(0.01, 1.0 - cl - cr)
            vis_h = max(0.01, 1.0 - ct - cb)
            inner_w = w / vis_w
            inner_h = h / vis_h
            inner_left = -cl * inner_w
            inner_top = -ct * inner_h
            return (f'<div class="abs{anim_classes}" style="left:{x:.1f}px;top:{y:.1f}px;'
                    f'width:{w:.1f}px;height:{h:.1f}px;overflow:hidden;{trans_css}"{anim_attrs}>'
                    f'<img src="{img_src}" style="position:absolute;left:{inner_left:.2f}px;'
                    f'top:{inner_top:.2f}px;width:{inner_w:.2f}px;height:{inner_h:.2f}px;max-width:none;" alt=""></div>')
        else:
            line_css = format_line_css(line)
            return f'<img class="pic{anim_classes}" src="{img_src}" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;{line_css}{trans_css}" alt=""{anim_attrs}>'

    anim_classes = shape_anim_classes
    anim_attrs = shape_anim_attrs
    uid = f"m_{slide_num}_{spid or int(x)}"

    # ---------------------------------------------------------------- freeforms
    if sh.get('paths'):
        line_col = line.get('color', 'none') if line else 'none'
        lw = max(1.0, line.get('width_px', 1.0)) if line else 1.0
        base_fill = 'none'
        defs_list, path_attrs = [], []
        if fill and fill.get('type') == 'solid':
            base_fill = fill.get('color', 'none')
        elif fill and fill.get('type') == 'gradient':
            gid = f'{uid}_grad'
            gdef = svg_gradient_def(gid, fill)
            if gdef:
                defs_list.append(gdef)
                base_fill = f'url(#{gid})'
        if line and line.get('tail'):
            L, W = arrow_dims(line, 'tail')
            d = arrow_marker_def(f'{uid}_tail', line['tail'].get('type'), L, W, line_col)
            if d:
                defs_list.append(d)
                path_attrs.append(f'marker-end="url(#{uid}_tail)"')
        if line and line.get('head'):
            L, W = arrow_dims(line, 'head')
            d = arrow_marker_def(f'{uid}_head', line['head'].get('type'), L, W, line_col)
            if d:
                defs_list.append(d)
                path_attrs.append(f'marker-start="url(#{uid}_head)"')
        defs_html = ('<defs>' + ''.join(defs_list) + '</defs>') if defs_list else ''
        extra = (' ' + ' '.join(path_attrs)) if path_attrs else ''
        dash = dash_attr(line.get('dash'), lw) if line else ''
        transforms = []
        if rot:
            transforms.append(f'rotate({rot:.1f}deg)')
        if flip_h:
            transforms.append('scaleX(-1)')
        if flip_v:
            transforms.append('scaleY(-1)')
        tcss = f'transform: {" ".join(transforms)}; transform-origin: 50% 50%;' if transforms else ''
        vw, vh = max(w, 1.0), max(h, 1.0)
        svg_paths = []
        for p_info in sh['paths']:
            pw = p_info.get('w') or w or 1.0
            ph = p_info.get('h') or h or 1.0
            sx = (w / pw) if (pw and w) else 1.0
            sy = (h / ph) if (ph and h) else 1.0
            d_val = scale_cust_path(p_info.get('d', ''), sx, sy)
            p_fill = base_fill
            if p_info.get('fill') == 'none':
                p_fill = 'none'
            p_stroke = line_col if p_info.get('stroke', True) else 'none'
            svg_paths.append(
                f'<svg class="abs {anim_classes}" viewBox="0 0 {vw:g} {vh:g}" '
                f'style="left:{x:.1f}px;top:{y:.1f}px;width:{vw:g}px;height:{vh:g}px;'
                f'overflow:visible;{tcss}"{anim_attrs}>{defs_html}'
                f'<path d="{d_val}" fill="{p_fill}" stroke="{p_stroke}" stroke-width="{lw:g}" '
                f'stroke-linejoin="round"{dash}{extra}/></svg>')
        return '\n'.join(svg_paths)

    # ------------------------------------------------------------- connectors
    connector_geoms = ('line', 'straightConnector1', 'straightConnector2', 'straightConnector3',
                       'straightConnector4', 'straightConnector5', 'bentConnector2',
                       'bentConnector3', 'bentConnector4', 'bentConnector5',
                       'curvedConnector2', 'curvedConnector3', 'curvedConnector4',
                       'curvedConnector5')
    is_connector = kind == 'line' or geom in connector_geoms
    if not is_connector and line and not fill and (w <= 3.0 or h <= 3.0):
        is_connector = True
    if is_connector:
        if not line:
            return ''
        return connector_render(sh, line, f"arr_{slide_num}_{spid or int(x)}",
                                anim_attrs, anim_classes)

    # ------------------------------------------------------- preset geometries
    flip_svg = []
    if flip_h:
        flip_svg.append('scaleX(-1)')
    if flip_v:
        flip_svg.append('scaleY(-1)')
    extra_svg_css = f'transform: {" ".join(flip_svg)}; transform-origin: 50% 50%;' if flip_svg else ''
    preset_markup = None
    if geom not in (None, 'rect', 'roundRect', 'ellipse', 'custom'):
        preset_markup = preset_shape_svg(geom, w, h, sh, fill, line, uid,
                                         inset=True, extra_transform=extra_svg_css)
    is_preset = preset_markup is not None

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

    # Fill and Line (preset geometries paint themselves inside their SVG)
    if not is_preset:
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

    anim_attrs = shape_anim_attrs
    if shape_anim_classes:
        classes.extend(shape_anim_classes.split())

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
        if body.get('wrap') == 'none':
            classes.append('nowrap')
            styles.append('white-space: nowrap;')

        font_scale = 1.0
        ln_reduction = 0.0
        autofit = body.get('autofit')
        if isinstance(autofit, dict):
            if autofit.get('font_scale_pct'):
                font_scale = autofit['font_scale_pct'] / 100.0
            ln_reduction = autofit.get('ln_spc_reduction_pct', 0.0) or 0.0

        p_list = []
        raw_paras = list(text.get('paragraphs', []))
        # Trailing empty paragraphs are invisible in PowerPoint but still add a
        # full line box here, which made normAutofit boxes look "overflowing"
        # and triggered the runtime shrink guard. Drop them (unless animated).
        while raw_paras:
            tail = raw_paras[-1]
            tail_idx = len(raw_paras) - 1
            if (tail.get('empty') or not any(r.get('text', '').strip() for r in tail.get('runs', []))) \
                    and (spid, tail_idx) not in para_anims:
                raw_paras.pop()
            else:
                break

        auto_counters = {}
        for p_idx, p in enumerate(raw_paras):
            b = p.get('bullet', '')
            auto_idx = 1
            if b and b.startswith('auto:'):
                b_key = (b, p.get('level', 0))
                auto_counters[b_key] = auto_counters.get(b_key, 0) + 1
                auto_idx = auto_counters[b_key]

            p_anim = para_anims.get((spid, p_idx))

            rendered_p = render_paragraph(p, slide_num, font_scale, p_idx, p_anim, auto_idx, ln_reduction, first=(p_idx == 0))
            if rendered_p:
                p_list.append(rendered_p)

        paragraphs_html = '\n'.join(p_list)
        content_html = ((preset_markup or '') + '\n' + paragraphs_html).strip()
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        # normAutofit: let the runtime shrink text exactly to the shape, the way
        # PowerPoint/LibreOffice recompute autofit when no fontScale is stored.
        needs_fit = isinstance(autofit, dict) and not autofit.get('font_scale_pct')
        autofit_attr = ' data-autofit="norm"' if needs_fit else ''
        return f'<div class="{class_attr}" style="{style_attr}"{anim_attrs}{autofit_attr}>\n{content_html}\n</div>'
    else:
        class_attr = ' '.join(classes)
        style_attr = ' '.join(styles)
        inner = (preset_markup or '').strip()
        return f'<div class="{class_attr}" style="{style_attr}"{anim_attrs}>{inner}</div>'

def normalize_actions(a):
    if not a:
        return []
    if isinstance(a, dict):
        return [a]
    return sorted(list(a), key=lambda x: (x.get('step', 1), x.get('delay_ms', 0)))


def anim_markup(actions, spid, para_idx=None):
    """Build animation classes + data attributes (including full multi-step timeline)."""
    actions = normalize_actions(actions)
    attrs = f' data-spid="{spid}"' if spid else ''
    if not actions:
        return '', attrs
    first = actions[0]
    first_vis = next((a for a in actions if a.get('type') in ('entr', 'exit')), None)
    init_cls = 'anim-hidden' if (first_vis and first_vis.get('type') == 'entr') else 'anim-visible'
    classes = ' '.join([
        'neo-anim-target',
        f"neo-anim-step-{first.get('step', 1)}",
        f"neo-anim-{first.get('effect', 'fade')}",
        init_cls,
    ])
    attrs += (f' data-anim-step="{first.get("step", 1)}"'
              f' data-anim-type="{first.get("type", "entr")}"'
              f' data-anim-effect="{first.get("effect", "fade")}"')
    if para_idx is not None:
        attrs += f' data-para-idx="{para_idx}"'
    timeline = []
    for a in actions:
        item = {k: a[k] for k in ('step', 'type', 'effect', 'dur_ms', 'delay_ms') if k in a}
        if a.get('kind') == 'path' or a.get('dx_px') is not None:
            item.update({'kind': 'path', 'dx_px': a.get('dx_px', 0),
                         'dy_px': a.get('dy_px', 0), 'motion_path': a.get('motion_path') or ''})
        timeline.append(item)
    attrs += ' data-anim-timeline="%s"' % html.escape(
        json.dumps(timeline, separators=(',', ':')), quote=True)
    return classes, attrs


def build_slide_anim_map(slide_data):
    anims = slide_data.get('animations')
    if not anims or not anims.get('steps'):
        return {}, {}

    shape_anims = {}
    para_anims = {}

    def add(store, key, action):
        lst = store.setdefault(key, [])
        sig = (action.get('step'), action.get('type'), action.get('effect'),
               action.get('dur_ms'), action.get('delay_ms'), action.get('dx_px'),
               action.get('dy_px'), action.get('motion_path'))
        for old in lst:
            if (old.get('step'), old.get('type'), old.get('effect'),
                    old.get('dur_ms'), old.get('delay_ms'), old.get('dx_px'),
                    old.get('dy_px'), old.get('motion_path')) == sig:
                return
        lst.append(action)

    for step_obj in anims['steps']:
        step_num = step_obj['step']
        for eff in step_obj.get('effects', []):
            target_spid = str(eff.get('spid', ''))
            p_range = eff.get('para_range')
            action = {
                'step': step_num,
                'type': eff.get('type', 'entr'),
                'effect': eff.get('effect', 'fade'),
                'kind': eff.get('kind', 'visibility'),
                'dur_ms': eff.get('dur_ms', 400),
                'delay_ms': eff.get('delay_ms', 0),
            }
            if eff.get('kind') == 'path':
                action['dx_px'] = eff.get('dx_px', 0)
                action['dy_px'] = eff.get('dy_px', 0)
                action['motion_path'] = eff.get('motion_path') or ''

            targets = []
            for sh in slide_data.get('shapes', []):
                sh_id = str(sh.get('id', ''))
                grp_ids = [str(g) for g in sh.get('group_ids', [])]
                if sh_id == target_spid or target_spid in grp_ids:
                    targets.append(sh_id)
            if not targets:
                targets = [target_spid]

            for sh_id in targets:
                if p_range is not None:
                    st, end = p_range
                    for p_i in range(st, end + 1):
                        add(para_anims, (sh_id, p_i), dict(action))
                else:
                    add(shape_anims, sh_id, dict(action))

    # Solid background-colored masks (borderless, ungrouped white rectangles)
    # placed directly behind an animated entrance should appear with it.
    shapes = slide_data.get('shapes', [])
    for sh_idx, sh in enumerate(shapes):
        sh_id = str(sh.get('id', ''))
        if sh_id in shape_anims:
            continue
        fill = sh.get('fill') or {}
        has_text = bool(sh.get('text') and any(not p.get('empty') for p in sh.get('text', {}).get('paragraphs', [])))
        is_bg_mask = (
            fill.get('type') == 'solid'
            and (fill.get('color') or '').lower() == '#ffffff'
            and not has_text
            and not sh.get('line')
            and not sh.get('group_ids')
            and sh.get('geometry') == 'rect'
        )
        if is_bg_mask:
            sx, sy, sw, sh_h = sh.get('x', 0), sh.get('y', 0), sh.get('w', 0), sh.get('h', 0)
            mask_area = sw * sh_h
            if mask_area > 0:
                for next_sh in shapes[sh_idx + 1:]:
                    next_id = str(next_sh.get('id', ''))
                    next_actions = shape_anims.get(next_id)
                    entr = next((a for a in normalize_actions(next_actions) if a.get('type') == 'entr'), None)
                    if entr:
                        nx, ny, nw, nh = next_sh.get('x', 0), next_sh.get('y', 0), next_sh.get('w', 0), next_sh.get('h', 0)
                        overlap_x = max(0, min(sx + sw, nx + nw) - max(sx, nx))
                        overlap_y = max(0, min(sy + sh_h, ny + nh) - max(sy, ny))
                        overlap_area = overlap_x * overlap_y
                        next_area = nw * nh
                        if next_area > 0 and overlap_area / next_area > 0.6 and overlap_area / mask_area > 0.4:
                            add(shape_anims, sh_id, dict(entr))
                            break

    for k in list(shape_anims):
        shape_anims[k] = sorted(shape_anims[k], key=lambda a: (a.get('step', 1), a.get('delay_ms', 0)))
    for k in list(para_anims):
        para_anims[k] = sorted(para_anims[k], key=lambda a: (a.get('step', 1), a.get('delay_ms', 0)))
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
        anim_script = r"""
  <script>
    (function() {
      var currentStep = 0;
      var targets = Array.prototype.slice.call(
        document.querySelectorAll('.neo-anim-target, [data-anim-timeline]'));

      function legacyActions(el) {
        var step = parseInt(el.getAttribute('data-anim-step') || '0', 10);
        if (!step) return [];
        return [{
          step: step,
          type: el.getAttribute('data-anim-type') || 'entr',
          effect: el.getAttribute('data-anim-effect') || 'fade',
          dur_ms: 400,
          delay_ms: 0
        }];
      }

      var maxStep = 0;
      var stepTimers = [];
      for (var i = 0; i < targets.length; i++) {
        var el = targets[i];
        var actions = null;
        try { actions = JSON.parse(el.getAttribute('data-anim-timeline') || 'null'); } catch (_) {}
        if (!actions || !actions.length) actions = legacyActions(el);
        actions.sort(function(a, b) {
          var ds = (a.step || 0) - (b.step || 0);
          if (ds !== 0) return ds;
          return (a.delay_ms || 0) - (b.delay_ms || 0);
        });
        el._neoActions = actions;
        for (var j = 0; j < actions.length; j++) {
          maxStep = Math.max(maxStep, parseInt(actions[j].step || 0, 10));
        }
      }

      function clearStepTimers() {
        while (stepTimers.length) {
          clearTimeout(stepTimers.pop());
        }
      }

      function setElementVisibility(el, visible) {
        if (visible) {
          el.classList.remove('anim-hidden');
          el.classList.add('anim-visible');
        } else {
          el.classList.add('anim-hidden');
          el.classList.remove('anim-visible');
        }
      }

      function runSingleAction(el, act) {
        var dur = parseInt(act.dur_ms || 0, 10);
        if (act.effect === 'appear' || act.effect === 'disappear') dur = 0;
        if (act.kind === 'path' || act.motion_path) {
          var targetPath = "path('" + act.motion_path + "')";
          el.style.transitionDuration = '0ms';
          el.style.transitionDelay = '0ms';
          el.style.offsetAnchor = '0% 0%';
          el.style.offsetRotate = '0deg';
          el.style.offsetPath = targetPath;
          el.style.offsetDistance = '0%';
          void el.offsetWidth;
          el.style.transitionDuration = (dur || 400) + 'ms';
          el.style.offsetDistance = '100%';
        } else if (act.type === 'entr') {
          el.style.transitionDuration = dur + 'ms';
          el.style.transitionDelay = '0ms';
          setElementVisibility(el, true);
        } else if (act.type === 'exit') {
          el.style.transitionDuration = dur + 'ms';
          el.style.transitionDelay = '0ms';
          setElementVisibility(el, false);
        }
      }

      function applyStep(step, animate) {
        var targetStep = Math.max(0, Math.min(step, maxStep));
        if (!animate && targetStep === currentStep && stepTimers.length > 0) {
          return;
        }
        clearStepTimers();
        currentStep = targetStep;
        for (var i = 0; i < targets.length; i++) {
          var el = targets[i];
          var actions = el._neoActions || [];
          var firstVis = null;
          for (var f = 0; f < actions.length; f++) {
            if (actions[f].type === 'entr' || actions[f].type === 'exit') { firstVis = actions[f]; break; }
          }
          var initialVisible = !(firstVis && firstVis.type === 'entr');

          if (!animate || currentStep === 0) {
            var visible = initialVisible;
            var motion = null;
            for (var a = 0; a < actions.length; a++) {
              var act = actions[a];
              if (parseInt(act.step || 0, 10) > currentStep) break;
              if (act.type === 'entr') visible = true;
              else if (act.type === 'exit') visible = false;
              if (act.kind === 'path' || act.motion_path) motion = act;
            }
            el.style.transitionDuration = '0ms';
            el.style.transitionDelay = '0ms';
            setElementVisibility(el, visible);
            if (motion && motion.motion_path) {
              el.style.offsetAnchor = '0% 0%';
              el.style.offsetRotate = '0deg';
              el.style.offsetPath = "path('" + motion.motion_path + "')";
              el.style.offsetDistance = '100%';
            } else if (el.style.offsetPath) {
              el.style.offsetPath = '';
              el.style.offsetDistance = '';
              el.style.offsetAnchor = '';
            }
          } else {
            // 1. Snap to state at the end of (currentStep - 1)
            var prevVisible = initialVisible;
            var prevMotion = null;
            var stepActs = [];
            for (var b = 0; b < actions.length; b++) {
              var pact = actions[b];
              var sNum = parseInt(pact.step || 0, 10);
              if (sNum < currentStep) {
                if (pact.type === 'entr') prevVisible = true;
                else if (pact.type === 'exit') prevVisible = false;
                if (pact.kind === 'path' || pact.motion_path) prevMotion = pact;
              } else if (sNum === currentStep) {
                stepActs.push(pact);
              }
            }
            el.style.transitionDuration = '0ms';
            el.style.transitionDelay = '0ms';
            setElementVisibility(el, prevVisible);

            var firstStepMotion = null;
            for (var m = 0; m < stepActs.length; m++) {
              if (stepActs[m].kind === 'path' || stepActs[m].motion_path) {
                firstStepMotion = stepActs[m];
                break;
              }
            }

            if (firstStepMotion && firstStepMotion.motion_path) {
              el.style.offsetAnchor = '0% 0%';
              el.style.offsetRotate = '0deg';
              el.style.offsetPath = "path('" + firstStepMotion.motion_path + "')";
              el.style.offsetDistance = '0%';
            } else if (prevMotion && prevMotion.motion_path) {
              el.style.offsetAnchor = '0% 0%';
              el.style.offsetRotate = '0deg';
              el.style.offsetPath = "path('" + prevMotion.motion_path + "')";
              el.style.offsetDistance = '100%';
            } else if (el.style.offsetPath) {
              el.style.offsetPath = '';
              el.style.offsetDistance = '';
              el.style.offsetAnchor = '';
            }

            void el.offsetWidth;

            // 2. Schedule each action in currentStep according to its delay_ms
            for (var k = 0; k < stepActs.length; k++) {
              (function(targetEl, actionObj) {
                var dMs = Math.max(0, parseInt(actionObj.delay_ms || 0, 10));
                if (dMs === 0) {
                  runSingleAction(targetEl, actionObj);
                } else {
                  stepTimers.push(setTimeout(function() {
                    runSingleAction(targetEl, actionObj);
                  }, dMs));
                }
              })(el, stepActs[k]);
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

      // Start at step 0 (initial hidden state for entrances). Allow static
      // capture / deep-linking via #step=N or #showall (used by QA tooling).
      applyStep(0, false);
      try {
        var hash = (location.hash || '').replace(/^#/, '');
        var stepMatch = hash.match(/^step=([0-9]+)$/);
        if (stepMatch) applyStep(parseInt(stepMatch[1], 10), false);
        else if (hash === 'showall' || hash === 'all') document.body.classList.add('show-all-anims');
      } catch (_) {}

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
"""

    fit_script = r"""
  <script>
    // Deterministic text fitting:
    //  - normAutofit boxes are scaled until their content matches the shape
    //    (PowerPoint/LibreOffice recompute this when fontScale is absent);
    //  - all other boxes only get a tiny <=5% metric-drift correction.
    (function() {
      function scaleBox(box, ratio) {
        var nodes = box.querySelectorAll('p, p span');
        for (var n = 0; n < nodes.length; n++) {
          var el = nodes[n];
          var fs = parseFloat(el.style.fontSize || getComputedStyle(el).fontSize);
          if (fs) el.style.fontSize = (fs * ratio) + 'px';
          var mt = parseFloat(el.style.marginTop || '0');
          var mb = parseFloat(el.style.marginBottom || '0');
          var pl = parseFloat(el.style.paddingLeft || '0');
          var ti = parseFloat(el.style.textIndent || '0');
          var lf = parseFloat(el.style.left || '0');
          var cs = getComputedStyle(el);
          if (mt) el.style.marginTop = (mt * ratio) + 'px';
          if (mb) el.style.marginBottom = (mb * ratio) + 'px';
          if (pl) el.style.paddingLeft = (pl * ratio) + 'px';
          if (ti) el.style.textIndent = (ti * ratio) + 'px';
          if (lf && cs.position === 'absolute') el.style.left = (lf * ratio) + 'px';
        }
      }
      function fitBoxes() {
        var boxes = document.querySelectorAll('.tb:not(.nowrap)');
        for (var i = 0; i < boxes.length; i++) {
          var box = boxes[i];
          var autofit = box.getAttribute('data-autofit') === 'norm';
          var guard = 0;
          var factor = 1;
          while (guard < 6 && (box.scrollHeight > box.clientHeight + 4 ||
                               box.scrollWidth > box.clientWidth + 4)) {
            var ratio = Math.min(
              box.clientHeight / Math.max(box.scrollHeight, 1),
              box.clientWidth / Math.max(box.scrollWidth, 1));
            if (!isFinite(ratio) || ratio >= 1) break;
            if (!autofit && ratio < 0.95) break;
            if (autofit && factor * ratio < 0.6) break;
            var step = autofit ? Math.max(0.6, ratio) : Math.max(0.95, ratio);
            factor *= step;
            scaleBox(box, step);
            guard++;
          }
        }
      }
      function schedule() { requestAnimationFrame(fitBoxes); }
      window.addEventListener('load', function() {
        schedule();
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
      });
      window.__neoFitTextBoxes = fitBoxes;
    })();
  </script>
"""

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
  </main>{fit_script}{anim_script}
</body>
</html>
'''
    return html_page

def generate_theme_css(data, used_fonts=None):
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
    if used_fonts is None:
        used_fonts = collect_used_fonts(data)
    font_faces = bundled_font_css(used_fonts)

    return f"""/* Auto-generated Theme CSS from PowerPoint */
{font_faces}
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

  --font-heading: {resolve_font_stack(heading_font)};
  --font-body: {resolve_font_stack(body_font)};
  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
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
.tb p {{ margin: 0; white-space: pre-wrap; }}
.tb.nowrap {{ white-space: pre; }}
.tb.nowrap p {{ white-space: pre; }}
.tb.anchor-t {{ justify-content: flex-start; }}
.tb.anchor-ctr {{ justify-content: center; }}
.tb.anchor-b {{ justify-content: flex-end; }}
.neo-tab {{ display: inline-block; }}

.preset-svg {{ display: block; }}


.heading {{ font-family: var(--font-heading); }}
.bullet-list {{ list-style: none; }}
.bullet-list li {{ position: relative; }}

img.pic {{ position: absolute; object-fit: fill; display: block; }}

/* Animation Targets & Effects */
.neo-anim-target {{
  offset-anchor: 0% 0%;
  transition: opacity 0.35s ease, transform 0.35s ease, clip-path 0.35s ease,
              offset-distance 0.35s ease;
  will-change: opacity, transform, clip-path, offset-distance;
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

.neo-anim-target.anim-visible {{
  opacity: 1;
  visibility: visible;
}}
body.show-all-anims .neo-anim-target,
body.edit-mode .neo-anim-target {{
  opacity: 1 !important;
  visibility: visible !important;
  clip-path: none !important;
  offset-distance: 100% !important;
  transition: none !important;
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

    # Copy metric-compatible bundled fonts that this deck references
    script_dir = os.path.dirname(os.path.abspath(__file__))
    copy_bundled_fonts(data, assets_dir, script_dir)

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
        notes_rel_path = f'slides/{folder_name}/notes.html'

        # Generate clean notes.html for the slide
        safe_notes_title = slide_title.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        notes_body = f'<p>{notes}</p>' if notes and not notes.startswith('<') else (notes or '<p></p>')
        notes_html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Speaker Notes - {safe_notes_title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body, {{delimiters: [{{left: '$$', right: '$$', display: true}}, {{left: '$', right: '$', display: false}}, {{left: '\\(', right: '\\)', display: false}}, {{left: '\\[', right: '\\]', display: true}}]}})"></script>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 28px 32px;
      line-height: 1.6;
      color: #1e293b;
      background: #ffffff;
      max-width: 900px;
      margin-inline: auto;
    }}
    @media (prefers-color-scheme: dark) {{
      body {{ color: #f1f5f9; background: #0f172a; }}
    }}
    h1, h2, h3, h4 {{ margin-top: 1.2em; margin-bottom: 0.5em; font-weight: 600; }}
    p {{ margin: 0.6em 0; }}
    a {{ color: #3b82f6; text-decoration: underline; word-break: break-all; }}
    a:hover {{ color: #60a5fa; }}
    img {{ max-width: 100%; height: auto; border-radius: 8px; margin: 12px 0; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); display: block; }}
    ul, ol {{ padding-left: 24px; margin: 0.6em 0; }}
    li {{ margin: 0.3em 0; }}
    blockquote {{ border-left: 3px solid #3b82f6; margin: 1em 0; padding-left: 14px; color: #64748b; }}
    code {{ font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.9em; padding: 2px 6px; background: rgba(148, 163, 184, 0.2); border-radius: 4px; }}
    .katex-display {{ margin: 1.2em 0; padding: 8px 0; overflow-x: auto; overflow-y: hidden; }}
    .katex {{ font-size: 1.15em; }}
  </style>
</head>
<body>
{notes_body}
</body>
</html>
'''
        with open(os.path.join(slide_dir, 'notes.html'), 'w', encoding='utf-8') as nf:
            nf.write(notes_html)

        slide_entry = {
            'id': f'slide-{active_idx}',
            'title': slide_title,
            'path': rel_path,
            'notesPath': notes_rel_path,
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
