#!/usr/bin/env python3
"""
extract_pptx.py - dependency-free (stdlib only) PPTX -> structured JSON extractor.

Produces everything an agent needs to rebuild a deck as HTML while staying true to
the original theme:

  <out>/extract.json     theme colors/fonts, master/layout decor, per-slide shapes
                         (geometry in 1920-wide canvas px, resolved text styling,
                         fills, borders, images, tables, charts) and speaker notes
  <out>/media/*          every image referenced by the deck (original bytes)
  <out>/reference/*.png  (optional, --render) rasterised slides for visual comparison
                         NOTE: LibreOffice skips hidden slides, so PNG numbering can lag
                         behind slide numbers; check each slide's "hidden" flag.

Usage:
  python3 extract_pptx.py deck.pptx --out ./pptx-extract [--render] [--width 1920]

Style resolution follows the OOXML inheritance chain:
  run rPr > paragraph pPr > shape lstStyle > layout placeholder > master placeholder > master txStyles
"""
import argparse
import colorsys
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'asvg': 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
}
EMU_PER_PT = 12700
DEFAULT_CLRMAP = {'bg1': 'lt1', 'tx1': 'dk1', 'bg2': 'lt2', 'tx2': 'dk2'}

# ---------------------------------------------------------------------------
# Symbol / dingbat decoders
# ---------------------------------------------------------------------------
# PowerPoint decks routinely use Symbol, Wingdings and ZapfDingbats for glyphs
# (bullets, arrows, checkmarks). Those fonts map ASCII/CP1252 bytes to symbols via
# a legacy encoding; without translation browsers render tofu or wrong Latin chars.

SYMBOL_MAP = {
    0x22: '∀', 0x24: '∃', 0x27: '∋', 0x2A: '∗', 0x2D: '−', 0x40: '≅',
    0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ',
    0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι', 0x4A: 'ϑ', 0x4B: 'Κ', 0x4C: 'Λ',
    0x4D: 'Μ', 0x4E: 'Ν', 0x4F: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ',
    0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x56: 'ς', 0x57: 'Ω', 0x58: 'Ξ',
    0x59: 'Ψ', 0x5A: 'Ζ', 0x5C: '∴', 0x5E: '⊥', 0x60: '‾',
    0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ',
    0x67: 'γ', 0x68: 'η', 0x69: 'ι', 0x6A: 'ϕ', 0x6B: 'κ', 0x6C: 'λ',
    0x6D: 'μ', 0x6E: 'ν', 0x6F: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ',
    0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ',
    0x79: 'ψ', 0x7A: 'ζ', 0x7E: '∼',
    0xA1: 'ϒ', 0xA2: '′', 0xA3: '≤', 0xA4: '⁄', 0xA5: '∞', 0xA6: 'ƒ',
    0xA7: '♣', 0xA8: '♦', 0xA9: '♥', 0xAA: '♠', 0xAB: '↔', 0xAC: '←',
    0xAD: '↑', 0xAE: '→', 0xAF: '↓', 0xB0: '°', 0xB1: '±', 0xB2: '″',
    0xB3: '≥', 0xB4: '×', 0xB5: '∝', 0xB6: '∂', 0xB7: '•', 0xB8: '÷',
    0xB9: '≠', 0xBA: '≡', 0xBB: '≈', 0xBC: '…', 0xBE: '⎯', 0xBF: '↵',
    0xC0: 'ℵ', 0xC1: 'ℑ', 0xC2: 'ℜ', 0xC3: '℘', 0xC4: '⊗', 0xC5: '⊕',
    0xC6: '∅', 0xC7: '∩', 0xC8: '∪', 0xC9: '⊃', 0xCA: '⊇', 0xCB: '⊄',
    0xCC: '⊂', 0xCD: '⊆', 0xCE: '∈', 0xCF: '∉', 0xD0: '∠', 0xD1: '∇',
    0xD5: '∏', 0xD6: '√', 0xD7: '⋅', 0xD8: '¬', 0xD9: '∧', 0xDA: '∨',
    0xDB: '⇔', 0xDC: '⇐', 0xDD: '⇑', 0xDE: '⇒', 0xDF: '⇓', 0xE0: '◊',
    0xE1: '〈', 0xE5: '∑',
}

# Wingdings is used mostly for bullets/arrows/checks. Codes below are the common
# glyphs PowerPoint emits (raw byte values before the 0xF000 PUA offset).
WINGDINGS_MAP = {
    0x20: ' ', 0x21: '✏', 0x6C: '●', 0x6D: '❍', 0x6E: '■', 0x6F: '❑',
    0x70: '❒', 0x71: '❑', 0x72: '❒', 0x73: '●', 0x74: '◗', 0x75: '⬩',
    0x76: '❖', 0x77: '◆', 0x78: '❖', 0x79: '✦', 0x7A: '✧', 0x7B: '★',
    0x7C: '✶', 0x7D: '✴', 0x7E: '✵',
    0xA1: '○', 0xA2: '◇', 0xA3: '□', 0xA4: '☺', 0xA5: '☻', 0xA6: '☼',
    0xA7: '▪', 0xA8: '▫', 0xA9: '✦', 0xAA: '★', 0xAB: '✶', 0xAC: '✳',
    0xAD: '✹', 0xAE: '✺', 0xAF: '✸', 0xB0: '✷', 0xB1: '✱', 0xB2: '✦',
    0xB3: '➔', 0xB4: '➘', 0xB5: '➙', 0xB6: '➚', 0xB7: '➛', 0xB8: '➜',
    0xB9: '➝', 0xBA: '➞', 0xBB: '➟', 0xBC: '➠', 0xBD: '➡', 0xBE: '➢',
    0xBF: '➣', 0xC0: '➤', 0xC1: '➥', 0xC2: '➦', 0xC3: '➧', 0xC4: '➨',
    0xC5: '➩', 0xC6: '➪', 0xC7: '➫', 0xC8: '➬', 0xC9: '➭', 0xCA: '➮',
    0xCB: '➯', 0xCC: '➱', 0xCD: '➲', 0xCE: '➳', 0xCF: '➴', 0xD0: '➵',
    0xD1: '➶', 0xD2: '➷', 0xD3: '➸', 0xD4: '➹', 0xD5: '➺', 0xD6: '➻',
    0xD7: '➼', 0xD8: '➢', 0xD9: '➽', 0xDA: '➾', 0xDB: '⬅', 0xDC: '➔',
    0xDD: '⬆', 0xDE: '⬇', 0xDF: '➡', 0xE0: '→', 0xE1: '⇒', 0xE2: '⇨',
    0xE3: '⇧', 0xE4: '⇩', 0xE5: '⇦', 0xE6: '⇗', 0xE7: '⇘', 0xE8: '➔',
    0xFC: '✓', 0xFD: '🗹', 0xFE: '☒', 0xFF: '☐',
}

DINGBATS_ASCII = (
    '✁✂✃✄☎✆✇✈✉☛☞✌✍✎✏✐✑✒✓✔✕✖✗✘✙✚✛✜✝✞✟'
    '✠✡✢✣✤✥✦✧★✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿'
)


def translate_symbol(text, font):
    """Translate Symbol/Wingdings/ZapfDingbats encoded text to Unicode."""
    if not text or not font:
        return text
    f = font.lower()
    if 'wingdings' in f or 'webdings' in f:
        table = WINGDINGS_MAP
    elif 'symbol' in f:
        table = SYMBOL_MAP
    elif 'zapfdingbats' in f or 'dingbat' in f:
        table = {0x20 + i: ch for i, ch in enumerate(DINGBATS_ASCII)}
    else:
        return text
    out = []
    for ch in text:
        code = ord(ch)
        # Symbol fonts are often stored in the Unicode Private Use Area (F020-F0FF).
        if 0xF020 <= code <= 0xF0FF:
            code -= 0xF000
        out.append(table.get(code, ch))
    return ''.join(out)


def q(prefix, tag):
    return '{%s}%s' % (NS[prefix], tag)


def local(el):
    return el.tag.split('}')[-1]


class Pkg:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = set(self.z.namelist())

    def xml(self, name):
        if name not in self.names:
            return None
        return ET.fromstring(self.z.read(name))

    def rels(self, part):
        d, b = posixpath.split(part)
        rp = posixpath.join(d, '_rels', b + '.rels')
        out = {}
        root = self.xml(rp)
        if root is None:
            return out
        for r in root:
            tgt = r.get('Target')
            external = r.get('TargetMode') == 'External'
            if not external:
                tgt = tgt.lstrip('/') if tgt.startswith('/') else posixpath.normpath(posixpath.join(d, tgt))
            out[r.get('Id')] = {'type': r.get('Type').split('/')[-1], 'target': tgt, 'external': external}
        return out


def extract_metafile_image(data):
    """Extract embedded vector or raster image (PDF via mutool, PNG, or JPEG) from an EMF/WMF binary."""
    # 1. Check for embedded PDF (common in Mac PowerPoint exports, e.g. fig42_table.pdf)
    pdf_start = data.find(b'%PDF')
    if pdf_start != -1:
        pdf_end = data.rfind(b'%%EOF')
        if pdf_end != -1 and pdf_end > pdf_start:
            pdf_bytes = data[pdf_start:pdf_end + 5]
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tf:
                tf.write(pdf_bytes)
                tf_path = tf.name
            out_png = tf_path + '.png'
            try:
                subprocess.run(['mutool', 'draw', '-r', '300', '-o', out_png, tf_path],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                if os.path.exists(out_png):
                    with open(out_png, 'rb') as f:
                        png_bytes = f.read()
                    os.unlink(out_png)
                    os.unlink(tf_path)
                    return png_bytes, '.png'
            except Exception:
                pass
            if os.path.exists(tf_path):
                os.unlink(tf_path)

    # 2. Check for embedded PNG
    png_start = data.find(b'\x89PNG\r\n\x1a\n')
    if png_start != -1:
        png_end = data.find(b'IEND', png_start)
        if png_end != -1 and png_end > png_start:
            return data[png_start:png_end + 8], '.png'

    # 3. Check for embedded JPEG
    jpg_start = data.find(b'\xff\xd8\xff')
    if jpg_start != -1:
        jpg_end = data.rfind(b'\xff\xd9')
        if jpg_end != -1 and jpg_end > jpg_start:
            return data[jpg_start:jpg_end + 2], '.jpg'

    return None, None


class Ctx:
    def __init__(self, pkg, canvas_w, out_dir):
        self.pkg = pkg
        self.out_dir = out_dir
        pres = pkg.xml('ppt/presentation.xml')
        sz = pres.find('p:sldSz', NS)
        self.cx, self.cy = int(sz.get('cx')), int(sz.get('cy'))
        self.scale = canvas_w / self.cx
        self.canvas_w = canvas_w
        self.canvas_h = round(self.cy * self.scale)
        self.pres, self.pres_rels = pres, pkg.rels('ppt/presentation.xml')
        self.theme, self.fonts = {}, {}
        self.clrmap = dict(DEFAULT_CLRMAP)
        self.media = {}  # zip path -> output filename
        self.master_root = None
        self.theme_ln_styles = []
        self.default_text_style = pres.find('p:defaultTextStyle', NS)

    def px(self, emu):
        return round(int(emu) * self.scale, 2)

    # ---------- colour ----------
    def color_of(self, parent):
        """parent: element containing srgbClr/schemeClr/sysClr/prstClr (e.g. a:solidFill)."""
        if parent is None:
            return None
        for ch in parent:
            n = local(ch)
            if n == 'srgbClr':
                rgb = '#' + ch.get('val').lower()
            elif n == 'sysClr':
                rgb = '#' + (ch.get('lastClr') or '000000').lower()
            elif n == 'prstClr':
                rgb = {'black': '#000000', 'white': '#ffffff'}.get(ch.get('val'), '#000000')
            elif n == 'schemeClr':
                v = ch.get('val')
                if v == 'phClr':
                    return None
                v = self.clrmap.get(v, v)
                rgb = self.theme.get(v, '#000000')
            else:
                continue
            return self._transform(rgb, ch)
        return None

    @staticmethod
    def _transform(rgb, ch):
        r, g, b = (int(rgb[i:i + 2], 16) for i in (1, 3, 5))
        alpha = 1.0
        for t in ch:
            n, v = local(t), int(t.get('val', '0'))
            if n in ('lumMod', 'lumOff'):
                h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
                l = l * v / 100000 if n == 'lumMod' else l + v / 100000
                r, g, b = (round(x * 255) for x in colorsys.hls_to_rgb(h, max(0, min(1, l)), s))
            elif n == 'tint':
                f = v / 100000
                r, g, b = (round(c + (255 - c) * (1 - f)) for c in (r, g, b))
            elif n == 'shade':
                f = v / 100000
                r, g, b = (round(c * f) for c in (r, g, b))
            elif n == 'alpha':
                alpha = v / 100000
        if alpha < 1:
            return 'rgba(%d,%d,%d,%.2f)' % (r, g, b, alpha)
        return '#%02x%02x%02x' % (r, g, b)

    # ---------- media ----------
    def copy_media(self, zip_path):
        if zip_path in self.media:
            return self.media[zip_path]
        name = posixpath.basename(zip_path)
        base, ext = os.path.splitext(name)
        raw_data = self.pkg.z.read(zip_path)

        # If EMF/WMF, check for embedded JPEG or PNG to ensure browser compatibility
        if ext.lower() in ('.emf', '.wmf'):
            extracted_img, new_ext = extract_metafile_image(raw_data)
            if extracted_img and new_ext:
                raw_data = extracted_img
                ext = new_ext

        final, i = '%s%s' % (base, ext), 1
        while final in self.media.values():
            final = '%s_%d%s' % (base, i, ext)
            i += 1
        os.makedirs(os.path.join(self.out_dir, 'media'), exist_ok=True)
        with open(os.path.join(self.out_dir, 'media', final), 'wb') as f:
            f.write(raw_data)
        self.media[zip_path] = final
        return final

    # ---------- fills ----------
    def fill_of(self, holder, rels):
        """Return fill description from an spPr/bgPr-like element."""
        if holder is None:
            return None
        sf = holder.find('a:solidFill', NS)
        if sf is not None:
            return {'type': 'solid', 'color': self.color_of(sf)}
        gf = holder.find('a:gradFill', NS)
        if gf is not None:
            stops = [{'pos': int(gs.get('pos')) / 1000, 'color': self.color_of(gs)} for gs in gf.findall('a:gsLst/a:gs', NS)]
            lin = gf.find('a:lin', NS)
            out = {'type': 'gradient', 'stops': stops}
            if lin is not None:
                out['angle_deg'] = int(lin.get('ang', '0')) / 60000
            elif gf.find('a:path', NS) is not None:
                out['path'] = gf.find('a:path', NS).get('path')
            return out
        bf = holder.find('a:blipFill', NS)
        if bf is not None:
            img = self.blip_target(bf, rels)
            if img:
                return {'type': 'image', 'image': img}
        if holder.find('a:noFill', NS) is not None:
            return {'type': 'none'}
        return None

    def blip_target(self, blipfill, rels):
        blip = blipfill.find('a:blip', NS)
        if blip is None:
            return None
        # Check for modern SVG blip in extension list
        svg = blip.find('.//asvg:svgBlip', NS)
        if svg is not None:
            rid = svg.get(q('r', 'embed'))
            if rid and rid in rels and rels[rid]['target'] in self.pkg.names:
                return 'media/' + self.copy_media(rels[rid]['target'])
        rid = blip.get(q('r', 'embed'))
        if rid and rid in rels and rels[rid]['target'] in self.pkg.names:
            return 'media/' + self.copy_media(rels[rid]['target'])
        return None

    def line_of(self, sppr):
        ln = sppr.find('a:ln', NS) if sppr is not None else None
        if ln is None or ln.find('a:noFill', NS) is not None:
            return None
        col = self.color_of(ln.find('a:solidFill', NS))
        if not col:
            return None
        d = ln.find('a:prstDash', NS)
        ret = {'color': col, 'width_px': self.px(int(ln.get('w', '12700'))), 'dash': d.get('val') if d is not None else 'solid'}
        for tag, key in (('headEnd', 'head'), ('tailEnd', 'tail')):
            e = ln.find('a:' + tag, NS)
            if e is not None and e.get('type') and e.get('type') != 'none':
                ret[key] = {'type': e.get('type'),
                            'w': e.get('w', 'med'),
                            'len': e.get('len', 'med')}
        return ret

    def style_line_of(self, style):
        """Resolve p:style/a:lnRef (idx>0) against the theme line style list."""
        if style is None:
            return None
        ref = style.find('a:lnRef', NS)
        if ref is None:
            return None
        try:
            idx = int(ref.get('idx', '0'))
        except ValueError:
            idx = 0
        if idx <= 0:
            return None
        col = self.color_of(ref)
        if not col:
            return None
        width_px = 1.0
        if 0 < idx <= len(self.theme_ln_styles):
            width_px = self.theme_ln_styles[idx - 1]
        return {'color': col, 'width_px': max(1.0, width_px), 'dash': 'solid'}

    def style_fill_of(self, style):
        """Resolve p:style/a:fillRef (idx>0) to a solid fill."""
        if style is None:
            return None
        ref = style.find('a:fillRef', NS)
        if ref is None:
            return None
        try:
            idx = int(ref.get('idx', '0'))
        except ValueError:
            idx = 0
        if idx <= 0:
            return None
        col = self.color_of(ref)
        return {'type': 'solid', 'color': col} if col else None


# ---------------------------------------------------------------- text ----
def rpr_props(ctx, el):
    if el is None:
        return {}
    o = {}
    if el.get('sz'):
        o['size_pt'] = int(el.get('sz')) / 100
    for k, key in (('b', 'bold'), ('i', 'italic')):
        if el.get(k) is not None:
            o[key] = el.get(k) in ('1', 'true')
    if el.get('u') and el.get('u') != 'none':
        o['underline'] = True
    if el.get('strike') and el.get('strike') != 'noStrike':
        o['strike'] = True
    if el.get('cap') == 'all':
        o['uppercase'] = True
    if el.get('baseline'):
        o['baseline'] = int(el.get('baseline')) / 1000
    if el.get('spc'):
        o['letter_spacing_pt'] = int(el.get('spc')) / 100
    col = ctx.color_of(el.find('a:solidFill', NS))
    if col:
        o['color'] = col
    latin = el.find('a:latin', NS)
    if latin is not None and latin.get('typeface'):
        tf = latin.get('typeface')
        o['font'] = ctx.fonts.get(tf, tf)
    return o


# Common PPT / Wingdings bullet symbol translation to standard Unicode
WINGDINGS_BULLET_MAP = {
    0x20: ' ',
    0x71: '❑',  # 113 square shadow
    0x72: '❒',  # 114
    0x75: '⬩',  # 117 small diamond
    0x76: '❖',  # 118 black florette / diamond
    0x77: '◆',  # 119 black diamond
    0x78: '✦',  # 120 star
    0xa7: '▪',  # 167 square bullet (PowerPoint default square bullet!)
    0xa8: '▫',  # 168 hollow square bullet
    0xa9: '✦',  # 169
    0xaa: '★',  # 170
    0xab: '✶',  # 171
    0xb2: '✦',  # 178
    0xd8: '➢',  # 216 3D arrow
    0xdc: '➔',  # 220 arrow
    0xe0: '→',  # 224 arrow
    0xfc: '✓',  # 252 checkmark
    0xfd: '🗹',  # 253 ballot check
    0xfe: '☒',  # 254 ballot x
}


def ppr_props(ctx, el, rels=None):
    if el is None:
        return {}
    o = {}
    for k in ('algn', 'marL', 'indent'):
        if el.get(k) is not None:
            o[k] = el.get(k) if k == 'algn' else ctx.px(el.get(k))
    for tag, key in (('lnSpc', 'line_spacing'), ('spcBef', 'space_before'), ('spcAft', 'space_after')):
        e = el.find('a:' + tag, NS)
        if e is None:
            continue
        pct, pts = e.find('a:spcPct', NS), e.find('a:spcPts', NS)
        if pct is not None:
            o[key] = {'percent': int(pct.get('val')) / 1000}
        elif pts is not None:
            o[key] = {'px': round(int(pts.get('val')) / 100 * EMU_PER_PT * ctx.scale, 2)}
    # Inherit buFont / buChar / buSz independently: the font is frequently set on
    # the master while the character is set on the slide (and vice versa).
    if el.find('a:buNone', NS) is not None:
        o['bullet'] = None
        o['bu_none'] = True
    else:
        bc_el = el.find('a:buChar', NS)
        if bc_el is not None:
            o['bu_char'] = bc_el.get('char', '')
        elif el.find('a:buAutoNum', NS) is not None:
            o['bullet'] = 'auto:' + el.find('a:buAutoNum', NS).get('type', 'arabicPeriod')
            o['bu_auto'] = True
    bf_el = el.find('a:buFont', NS)
    if bf_el is not None and bf_el.get('typeface'):
        o['bu_font'] = bf_el.get('typeface')
    if el.find('a:buSzPct', NS) is not None:
        o['bu_sz_pct'] = int(el.find('a:buSzPct', NS).get('val')) / 1000
    if el.find('a:buSzPts', NS) is not None:
        o['bu_sz_px'] = round(int(el.find('a:buSzPts', NS).get('val')) / 100 * EMU_PER_PT * ctx.scale, 2)
    bc = ctx.color_of(el.find('a:buClr', NS))
    if bc:
        o['bullet_color'] = bc
    tlst = el.find('a:tabLst', NS)
    if tlst is not None:
        o['tab_stops'] = [ctx.px(t.get('pos')) for t in tlst.findall('a:tab', NS) if t.get('pos')]
    return o


def merge_ppr(dst, props):
    """Merge paragraph props, honouring `<a:buNone/>` as an explicit override.

    ``buChar``/``buFont`` are frequently defined on the master while the layout
    or slide suppresses the bullet with ``buNone``.  ``dict.update`` alone would
    keep the inherited character, so clear the bullet keys when buNone wins.
    """
    if props.get('bu_none'):
        for k in ('bu_char', 'bu_font', 'bu_sz_pct', 'bu_sz_px', 'bullet', 'bullet_color', 'bu_auto'):
            dst.pop(k, None)
    elif props.get('bu_auto'):
        # <a:buAutoNum> overrides any bullet character inherited from master/layout.
        for k in ('bu_char', 'bu_font', 'bu_none'):
            dst.pop(k, None)
    elif 'bu_char' in props or props.get('bullet'):
        # A concrete bullet on a higher-priority source overrides an inherited buNone.
        dst.pop('bu_none', None)
    dst.update(props)
    return dst


def lvl_style(ctx, sources, lvl):
    """Merge lvlNpPr (+defRPr) across inheritance sources (lowest priority first)."""
    ppr, rpr = {}, {}
    for src in sources:
        if src is None:
            continue
        el = src.find('a:lvl%dpPr' % (lvl + 1), NS)
        if el is None:
            continue
        merge_ppr(ppr, ppr_props(ctx, el))
        rpr.update(rpr_props(ctx, el.find('a:defRPr', NS)))
    return ppr, rpr


def parse_text(ctx, txbody, sources, rels, chain=None):
    if txbody is None:
        return None
    paras = []
    for p in txbody.findall('a:p', NS):
        pel = p.find('a:pPr', NS)
        lvl = int(pel.get('lvl', '0')) if pel is not None else 0
        ppr, base_rpr = lvl_style(ctx, sources, lvl)
        merge_ppr(ppr, ppr_props(ctx, pel))
        # buFont and buChar can be inherited from different levels, so translate
        # only after the complete inheritance chain has been merged. A buNone on
        # any higher-priority source must suppress an inherited buChar.
        if 'bu_char' in ppr and not ppr.get('bu_none') and not ppr.get('bu_auto'):
            bullet_font = ppr.get('bu_font', '')
            ch = ppr['bu_char']
            if not bullet_font and ch == '§':
                bullet_font = 'Wingdings'  # legacy raw CP1252 square bullet
            ppr['bullet'] = translate_symbol(ch, bullet_font)
        runs = []
        for ch in p:
            n = local(ch)
            if n in ('r', 'fld'):
                t = ch.find('a:t', NS)
                rpr = dict(base_rpr)
                rpr.update(rpr_props(ctx, ch.find('a:rPr', NS)))
                sym = ch.find('a:sym', NS)
                if sym is not None:
                    text = sym.get('char', '')
                    if sym.get('typeface'):
                        rpr['font'] = ctx.fonts.get(sym.get('typeface'), sym.get('typeface'))
                else:
                    text = t.text if t is not None and t.text else ''
                if text and rpr.get('font'):
                    text = translate_symbol(text, rpr['font'])
                run = {'text': text}
                run.update(rpr)
                if 'size_pt' in run:
                    run['size_px'] = round(run['size_pt'] * EMU_PER_PT * ctx.scale, 1)
                hl = ch.find('a:rPr/a:hlinkClick', NS)
                if hl is not None and hl.get(q('r', 'id')) in rels:
                    run['link'] = rels[hl.get(q('r', 'id'))]['target']
                if n == 'fld':
                    run['field'] = ch.get('type')
                runs.append(run)
            elif n == 'br':
                runs.append({'text': '\n'})
            elif n == 'tab':
                run = {'text': '\t', 'tab': True}
                run.update(base_rpr)
                runs.append(run)
        if not runs:
            end = p.find('a:endParaRPr', NS)
            rpr = dict(base_rpr)
            rpr.update(rpr_props(ctx, end))
            if 'size_pt' in rpr:
                rpr['size_px'] = round(rpr['size_pt'] * EMU_PER_PT * ctx.scale, 1)
            paras.append({'empty': True, 'level': lvl, **{k: v for k, v in ppr.items()}, 'style': rpr})
            continue
        para = {'level': lvl, 'runs': runs}
        para.update(ppr)
        paras.append(para)
    # ---- bodyPr: merge master -> layout -> shape, then apply OOXML defaults ----
    info = {}
    body_prs = []
    for anc in (chain or []):
        if anc is not None:
            bp = anc.find('p:txBody/a:bodyPr', NS)
            if bp is not None:
                body_prs.append(bp)
    own_body = txbody.find('a:bodyPr', NS)
    if own_body is not None:
        body_prs.append(own_body)
    for body in body_prs:
        for k in ('anchor', 'anchorCtr', 'wrap', 'vert'):
            if body.get(k):
                info[k] = body.get(k)
        for k, key in (('lIns', 'pad_left'), ('tIns', 'pad_top'), ('rIns', 'pad_right'), ('bIns', 'pad_bottom')):
            if body.get(k) is not None:
                info[key] = ctx.px(body.get(k))
        na = body.find('a:normAutofit', NS)
        if na is not None:
            fit = {'ln_spc_reduction_pct': int(na.get('lnSpcReduction', '0')) / 1000}
            # Only trust a stored fontScale: when it is absent PowerPoint has not
            # (yet) fitted the text, so the renderer must recompute it at runtime.
            if na.get('fontScale') is not None:
                fit['font_scale_pct'] = int(na.get('fontScale')) / 1000
            info['autofit'] = fit
        elif body.find('a:spAutoFit', NS) is not None:
            info['autofit'] = 'shape'
    # OOXML defaults: lIns=rIns=91440 EMU (0.1in), tIns=bIns=45720 EMU (0.05in)
    info.setdefault('pad_left', ctx.px(91440))
    info.setdefault('pad_right', ctx.px(91440))
    info.setdefault('pad_top', ctx.px(45720))
    info.setdefault('pad_bottom', ctx.px(45720))
    return {'paragraphs': paras, 'body': info}


# --------------------------------------------------------------- shapes ----
def nv_pr(sp):
    for ch in sp:
        if local(ch).startswith('nv'):
            return ch.find('p:nvPr', NS), ch.find('p:cNvPr', NS)
    return None, None


def ph_of(sp):
    nvpr, _ = nv_pr(sp)
    ph = nvpr.find('p:ph', NS) if nvpr is not None else None
    if ph is None:
        return None
    return {'type': ph.get('type', 'body'), 'idx': ph.get('idx')}


def norm_ph(t):
    return {'ctrTitle': 'title', 'subTitle': 'body', 'obj': 'body'}.get(t, t)


def find_ph(tree_root, ph):
    if tree_root is None or ph is None:
        return None
    best = None
    for sp in tree_root.iter():
        if local(sp) not in ('sp', 'pic', 'graphicFrame'):
            continue
        cand = ph_of(sp)
        if not cand:
            continue
        if ph['idx'] is not None and cand['idx'] == ph['idx']:
            return sp
        if best is None and norm_ph(cand['type']) == norm_ph(ph['type']) and ph['type'] != 'body':
            best = sp
    return best


def get_xfrm(sp):
    for path in ('p:spPr/a:xfrm', 'p:grpSpPr/a:xfrm', 'p:xfrm'):
        x = sp.find(path, NS)
        if x is not None:
            return x
    return None


def cust_geom_path(p_elem, default_w, default_h):
    """Convert an OOXML a:path into an SVG path string (including arcTo)."""
    path_w = float(p_elem.get('w') or default_w or 0)
    path_h = float(p_elem.get('h') or default_h or 0)
    d_cmds = []
    cur = [0.0, 0.0]
    for child in p_elem:
        ctag = local(child)
        if ctag == 'moveTo':
            pt = child.find('a:pt', NS)
            if pt is not None:
                cur = [float(pt.get('x', '0')), float(pt.get('y', '0'))]
                d_cmds.append('M %g %g' % (cur[0], cur[1]))
        elif ctag == 'lnTo':
            pt = child.find('a:pt', NS)
            if pt is not None:
                cur = [float(pt.get('x', '0')), float(pt.get('y', '0'))]
                d_cmds.append('L %g %g' % (cur[0], cur[1]))
        elif ctag == 'cubicBezTo':
            pts = child.findall('a:pt', NS)
            if len(pts) == 3:
                d_cmds.append('C %g %g, %g %g, %g %g' % tuple(
                    float(pts[i].get(k, '0')) for i in range(3) for k in ('x', 'y')))
                cur = [float(pts[2].get('x', '0')), float(pts[2].get('y', '0'))]
        elif ctag == 'quadBezTo':
            pts = child.findall('a:pt', NS)
            if len(pts) == 2:
                d_cmds.append('Q %g %g, %g %g' % tuple(
                    float(pts[i].get(k, '0')) for i in range(2) for k in ('x', 'y')))
                cur = [float(pts[1].get('x', '0')), float(pts[1].get('y', '0'))]
        elif ctag == 'arcTo':
            wr = float(child.get('wR', '0'))
            hr = float(child.get('hR', '0'))
            st = float(child.get('stAng', '0')) / 60000.0
            sw = float(child.get('swAng', '0')) / 60000.0
            if wr and hr:
                import math
                st_r, sw_r = math.radians(st), math.radians(sw)
                cx = cur[0] - wr * math.cos(st_r)
                cy = cur[1] - hr * math.sin(st_r)
                ex = cx + wr * math.cos(st_r + sw_r)
                ey = cy + hr * math.sin(st_r + sw_r)
                large = 1 if abs(sw) > 180 else 0
                sweep = 1 if sw > 0 else 0
                d_cmds.append('A %g %g 0 %d %d %g %g' % (wr, hr, large, sweep, ex, ey))
                cur = [ex, ey]
        elif ctag == 'close':
            d_cmds.append('Z')
    out = {'w': path_w, 'h': path_h, 'd': ' '.join(d_cmds)}
    if p_elem.get('fill'):
        out['fill'] = p_elem.get('fill')
    if p_elem.get('stroke') is not None:
        out['stroke'] = p_elem.get('stroke') != '0'
    return out


def parse_geometry(ctx, sppr, raw_w, raw_h):
    """Extract prstGeom / avLst / custGeom for shapes AND connectors."""
    out = {}
    if sppr is None:
        return out
    geom = sppr.find('a:prstGeom', NS)
    cust = sppr.find('a:custGeom', NS)
    if geom is not None:
        out['geometry'] = geom.get('prst') or 'rect'
        adj = {}
        for g in geom.findall('a:avLst/a:gd', NS):
            fmla = g.get('fmla', '')
            m = re.search(r'-?\d+(?:\.\d+)?', fmla)
            if m:
                adj[g.get('name')] = float(m.group(0))
        if adj:
            out['geometry_adjust'] = adj
    elif cust is not None:
        out['geometry'] = 'custom'
        paths = [cust_geom_path(p, raw_w, raw_h)
                 for p in cust.findall('a:pathLst/a:path', NS)]
        paths = [p for p in paths if p['d']]
        if paths:
            out['paths'] = paths
    else:
        out['geometry'] = 'rect'
    return out


def apply_group_transform(tf, x, y, w, h, own_rot=0.0, own_fh=False, own_fv=False):
    """Map an EMU box through enclosing group transforms (innermost to outermost).

    tf is a sequence of group frames:
      (off_x, off_y, ext_cx, ext_cy, chOff_x, chOff_y, chExt_cx, chExt_cy, rot, flipH, flipV)
    """
    xa, ya, wa, ha = float(x), float(y), float(w), float(h)
    tot_rot = float(own_rot or 0.0)
    tot_fh = bool(own_fh)
    tot_fv = bool(own_fv)
    for frame in reversed(tf or ()):
        ox, oy, ecx, ecy, cox, coy, cecx, cecy, grot, gfh, gfv = frame
        sx = ecx / (cecx or 1.0)
        sy = ecy / (cecy or 1.0)
        xa = ox + (xa - cox) * sx
        ya = oy + (ya - coy) * sy
        wa = wa * sx
        ha = ha * sy
        if gfh or gfv or grot:
            cx = ox + ecx / 2.0
            cy = oy + ecy / 2.0
            if gfh:
                xa = 2.0 * cx - (xa + wa)
                tot_fh = not tot_fh
                if tot_rot:
                    tot_rot = -tot_rot
            if gfv:
                ya = 2.0 * cy - (ya + ha)
                tot_fv = not tot_fv
                if tot_rot:
                    tot_rot = -tot_rot
            if grot:
                import math
                a = math.radians(grot)
                scx, scy = xa + wa / 2.0, ya + ha / 2.0
                dx, dy = scx - cx, scy - cy
                scx = cx + dx * math.cos(a) - dy * math.sin(a)
                scy = cy + dx * math.sin(a) + dy * math.cos(a)
                xa, ya = scx - wa / 2.0, scy - ha / 2.0
                tot_rot += grot
    return xa, ya, wa, ha, tot_rot, tot_fh, tot_fv


def apply_group(tf, x, y, w, h):
    gx, gy, sx, sy = tf
    return gx + (x) * sx, gy + (y) * sy, w * sx, h * sy


def parse_shape(ctx, sp, rels, chain, tf, source, master_txstyles):
    """chain: [master_sp, layout_sp] inheritance elements for placeholders (may be None)."""
    kind = local(sp)
    nvpr, cnv = nv_pr(sp)
    ph = ph_of(sp)
    name = cnv.get('name') if cnv is not None else ''
    sp_id = cnv.get('id') if cnv is not None else None
    out = {'id': sp_id, 'spid': sp_id, 'name': name, 'kind': kind}
    if cnv is not None and cnv.get('descr'):
        out['alt_text'] = cnv.get('descr')
    if ph:
        out['placeholder'] = ph['type']

    # geometry (own > layout > master)
    xf = get_xfrm(sp)
    if xf is None and chain:
        for anc in reversed(chain):
            if anc is not None and get_xfrm(anc) is not None:
                xf = get_xfrm(anc)
                break
    raw_w = raw_h = 0
    if xf is not None and xf.find('a:off', NS) is not None:
        off, ext = xf.find('a:off', NS), xf.find('a:ext', NS)
        x, y, w, h = int(off.get('x')), int(off.get('y')), int(ext.get('cx')), int(ext.get('cy'))
        raw_w, raw_h = w, h
        own_rot = int(xf.get('rot', '0')) / 60000.0
        own_fh = xf.get('flipH') == '1'
        own_fv = xf.get('flipV') == '1'
        x, y, w, h, tot_rot, tot_fh, tot_fv = apply_group_transform(
            tf, x, y, w, h, own_rot, own_fh, own_fv)
        out['x'], out['y'] = ctx.px(x), ctx.px(y)
        out['w'], out['h'] = ctx.px(w), ctx.px(h)
        if tot_rot:
            out['rotation_deg'] = tot_rot
        if tot_fh:
            out['flipH'] = True
        if tot_fv:
            out['flipV'] = True

    sppr = sp.find('p:spPr', NS)
    style_el = sp.find('p:style', NS)
    fill = ctx.fill_of(sppr, rels) if sppr is not None else None
    if fill is None and chain:
        for anc in reversed(chain):
            if anc is not None:
                fill = ctx.fill_of(anc.find('p:spPr', NS), rels)
                if fill:
                    break
    if fill is None:
        fill = ctx.style_fill_of(style_el)
    if fill:
        out['fill'] = fill
    ln = ctx.line_of(sppr) if sppr is not None else None
    # A shape with an explicit <a:ln><a:noFill/> must stay borderless; only a
    # completely absent <a:ln> may inherit p:style/a:lnRef.
    if ln is None and (sppr is None or sppr.find('a:ln', NS) is None):
        ln = ctx.style_line_of(style_el)
    if ln:
        out['line'] = ln

    if kind == 'sp':
        out.update(parse_geometry(ctx, sppr, raw_w, raw_h))
        if sppr is not None and sppr.find('a:effectLst/a:outerShdw', NS) is not None:
            out['shadow'] = True
        # text
        srcs = []
        if ctx.default_text_style is not None:
            srcs.append(ctx.default_text_style)
        if ph and norm_ph(ph['type']) == 'title':
            srcs.append(master_txstyles.get('titleStyle'))
        elif ph and ph['type'] in ('dt', 'ftr', 'sldNum'):
            srcs.append(master_txstyles.get('otherStyle'))
        elif ph:
            srcs.append(master_txstyles.get('bodyStyle'))
        else:
            srcs.append(master_txstyles.get('otherStyle'))
        for anc in (chain or []):
            if anc is not None:
                srcs.append(anc.find('p:txBody/a:lstStyle', NS))
        srcs.append(sp.find('p:txBody/a:lstStyle', NS))
        text = parse_text(ctx, sp.find('p:txBody', NS), srcs, rels, chain)
        if text and any(not p.get('empty') for p in text['paragraphs']):
            out['text'] = text
        elif text and out.get('fill') is None and out.get('line') is None and not ph:
            return None
        elif text:
            out['text'] = text  # keep empty paragraphs' styling for filled shapes
        # p:style/a:fontRef supplies the default run colour / typeface
        if text:
            fr = style_el.find('a:fontRef', NS) if style_el is not None else None
            if fr is not None:
                fcol = ctx.color_of(fr)
                for para in text['paragraphs']:
                    for run in para.get('runs', []):
                        if fcol and 'color' not in run:
                            run['color'] = fcol
            if not ph and 'text' not in out and not out.get('fill') and not out.get('line'):
                return None
    elif kind == 'pic':
        bf = sp.find('p:blipFill', NS)
        img = ctx.blip_target(bf, rels) if bf is not None else None
        if not img:
            return None
        out['image'] = img
        src = bf.find('a:srcRect', NS)
        if src is not None:
            out['crop_pct'] = {k: int(src.get(k, '0')) / 1000 for k in ('l', 't', 'r', 'b')}
        geom = sppr.find('a:prstGeom', NS) if sppr is not None else None
        if geom is not None and geom.get('prst') != 'rect':
            out['geometry'] = geom.get('prst')
    elif kind == 'graphicFrame':
        gd = sp.find('a:graphic/a:graphicData', NS)
        uri = gd.get('uri', '') if gd is not None else ''
        if uri.endswith('/table'):
            out['table'] = parse_table(ctx, gd.find('a:tbl', NS), rels, master_txstyles)
        elif uri.endswith('/chart'):
            ch = gd.find('c:chart', NS)
            rid = ch.get(q('r', 'id')) if ch is not None else None
            out['chart'] = parse_chart(ctx, rels[rid]['target']) if rid in rels else {'unsupported': True}
        else:
            out['unsupported'] = uri.split('/')[-1] or 'graphicFrame'  # e.g. SmartArt: use reference PNG
    elif kind == 'cxnSp':
        out['kind'] = 'line'
        out.update(parse_geometry(ctx, sppr, raw_w, raw_h))
        if not out.get('line'):
            return None
    return out


def parse_table(ctx, tbl, rels, master_txstyles):
    cols = [ctx.px(g.get('w')) for g in tbl.findall('a:tblGrid/a:gridCol', NS)]
    rows = []
    for tr in tbl.findall('a:tr', NS):
        cells = []
        for tc in tr.findall('a:tc', NS):
            cell = {'text': parse_text(ctx, tc.find('a:txBody', NS), [master_txstyles.get('otherStyle')], rels)}
            tcpr = tc.find('a:tcPr', NS)
            if tcpr is not None:
                f = ctx.fill_of(tcpr, rels)
                if f:
                    cell['fill'] = f
            for a in ('gridSpan', 'rowSpan'):
                if tc.get(a):
                    cell[a] = int(tc.get(a))
            cells.append(cell)
        rows.append({'height_px': ctx.px(tr.get('h')), 'cells': cells})
    props = tbl.find('a:tblPr', NS)
    return {'column_widths_px': cols, 'rows': rows,
            'first_row_header': props is not None and props.get('firstRow') == '1',
            'banded_rows': props is not None and props.get('bandRow') == '1'}


def parse_chart(ctx, part):
    root = ctx.pkg.xml(part)
    if root is None:
        return {'unsupported': True}
    plot = root.find('.//c:plotArea', NS)
    out = {'types': [], 'series': []}
    for ch in plot:
        n = local(ch)
        if n.endswith('Chart'):
            out['types'].append(n)
            if ch.find('c:barDir', NS) is not None:
                out['bar_direction'] = ch.find('c:barDir', NS).get('val')
            if ch.find('c:grouping', NS) is not None:
                out['grouping'] = ch.find('c:grouping', NS).get('val')
            for ser in ch.findall('c:ser', NS):
                def vals(path):
                    return [v.text for v in ser.findall(path + '//c:pt/c:v', NS)]
                s = {'name': (ser.find('c:tx//c:v', NS).text if ser.find('c:tx//c:v', NS) is not None else ''),
                     'categories': vals('c:cat'), 'values': vals('c:val')}
                col = ctx.color_of(ser.find('c:spPr/a:solidFill', NS))
                if col:
                    s['color'] = col
                out['series'].append(s)
    t = root.find('.//c:title//a:t', NS)
    if t is not None:
        out['title'] = t.text
    out['has_legend'] = root.find('.//c:legend', NS) is not None
    return out


def walk_tree(ctx, tree, rels, layout_root, master_root, tf, source, master_txstyles, out, group_ids=None):
    if tree is None:
        return
    for sp in tree:
        n = local(sp)
        if n in ('sp', 'pic', 'graphicFrame', 'cxnSp'):
            chain = None
            ph = ph_of(sp) if n != 'cxnSp' else None
            if ph and source == 'slide':
                chain = [find_ph(master_root, ph), find_ph(layout_root, ph)]
            res = parse_shape(ctx, sp, rels, chain, tf, source, master_txstyles)
            if res:
                if group_ids:
                    res['group_ids'] = list(group_ids)
                out.append(res)
        elif n == 'grpSp':
            _, cnv = nv_pr(sp)
            grp_id = cnv.get('id') if cnv is not None else None
            new_groups = list(group_ids or [])
            if grp_id:
                new_groups.append(str(grp_id))
            xf = sp.find('p:grpSpPr/a:xfrm', NS)
            ntf = tf
            if xf is not None and xf.find('a:chExt', NS) is not None:
                off, ext = xf.find('a:off', NS), xf.find('a:ext', NS)
                choff, chext = xf.find('a:chOff', NS), xf.find('a:chExt', NS)
                rot = int(xf.get('rot', '0')) / 60000.0
                fh = xf.get('flipH') == '1'
                fv = xf.get('flipV') == '1'
                frame = (
                    int(off.get('x')), int(off.get('y')),
                    int(ext.get('cx')), int(ext.get('cy')),
                    int(choff.get('x')), int(choff.get('y')),
                    int(chext.get('cx')) or 1, int(chext.get('cy')) or 1,
                    rot, fh, fv,
                )
                ntf = tuple(tf) + (frame,)
            walk_tree(ctx, sp, rels, layout_root, master_root, ntf, source, master_txstyles, out, new_groups)


def _motion_path_to_px(path, cw, ch):
    """Convert a normalized OOXML motion path into slide-pixel SVG path + delta."""
    if not path:
        return None, 0.0, 0.0
    toks = path.replace(',', ' ').split()
    out = []
    pts = []
    cmd = None
    i = 0
    counts = {'M': 2, 'L': 2, 'T': 2, 'C': 6, 'Q': 4, 'S': 4}
    while i < len(toks):
        t = toks[i]
        if t in ('M', 'L', 'T', 'C', 'Q', 'S', 'Z', 'E'):
            cmd = t
            i += 1
            if t in ('Z', 'E'):
                out.append('Z')
            else:
                out.append(t)
            continue
        n = counts.get(cmd, 2)
        nums = []
        try:
            while len(nums) < n and i < len(toks):
                nums.append(float(toks[i]))
                i += 1
        except ValueError:
            i += 1
            continue
        for j in range(0, len(nums) - 1, 2):
            x, y = nums[j] * cw, nums[j + 1] * ch
            pts.append((x, y))
            out.append('%g %g' % (x, y))
    d = ' '.join(out)
    if len(pts) >= 2:
        dx = pts[-1][0] - pts[0][0]
        dy = pts[-1][1] - pts[0][1]
    else:
        dx = dy = 0.0
    return d, dx, dy


def parse_slide_timing(root, ctx):
    timing = root.find('p:timing', NS)
    if timing is None:
        return None
    seq = timing.find('.//p:seq', NS)
    if seq is None:
        return None
    cTn_seq = seq.find('p:cTn', NS)
    if cTn_seq is None:
        return None
    childTnLst = cTn_seq.find('p:childTnLst', NS)
    if childTnLst is None:
        return None

    # Parent map so a behaviour can inherit nodeType from an enclosing cTn.
    parents = {}
    for parent in timing.iter():
        for child in parent:
            parents[child] = parent

    flat = []
    top_pars = childTnLst.findall('p:par', NS)
    for par_i, par in enumerate(top_pars):
        # document order of effect containers (presetClass is set on effect cTns)
        for ctn in par.iter(q('p', 'cTn')):
            pClass = ctn.get('presetClass')
            if not pClass:
                continue
            # nearest nodeType on the ancestor chain
            node_type = 'clickEffect'
            anc = ctn
            while anc is not None:
                nt = anc.get('nodeType')
                if nt in ('clickEffect', 'withEffect', 'afterEffect'):
                    node_type = nt
                    break
                anc = parents.get(anc)
            dur_candidates = []
            for d_el in [ctn] + ctn.findall('.//p:cBhvr/p:cTn', NS):
                d_val = d_el.get('dur')
                if d_val and str(d_val).isdigit():
                    dur_candidates.append(int(d_val))
            dur_ms = max(dur_candidates) if dur_candidates else 400
            stconds = ctn.findall('p:stCondLst/p:cond', NS)
            delay_ms = 0
            if stconds and stconds[0].get('delay') and str(stconds[0].get('delay')).isdigit():
                delay_ms = int(stconds[0].get('delay'))
            pId = ctn.get('presetID')
            subType = ctn.get('presetSubtype')

            anim_motion = ctn.find('.//p:animMotion', NS)
            set_el = ctn.find('.//p:set', NS)
            anim_eff = ctn.find('.//p:animEffect', NS)
            effect_filter = anim_eff.get('filter') if anim_eff is not None else None

            effect_name = 'appear'
            effect_kind = 'visibility'
            motion = {}
            if anim_motion is not None:
                effect_name = 'motion'
                effect_kind = 'path'
                d_px, dx, dy = _motion_path_to_px(anim_motion.get('path'), ctx.canvas_w, ctx.canvas_h)
                motion = {'motion_path': d_px, 'dx_px': round(dx, 2), 'dy_px': round(dy, 2)}
            elif set_el is not None:
                to_el = set_el.find('p:to', NS)
                value = None
                if to_el is not None:
                    sv = to_el.find('p:strVal', NS)
                    value = sv.get('val') if sv is not None else None
                if value == 'hidden' or pClass == 'exit':
                    effect_name = 'disappear'
                else:
                    effect_name = 'appear'
            elif effect_filter:
                if 'dissolve' in effect_filter or 'fade' in effect_filter:
                    effect_name = 'fade'
                elif 'wipe' in effect_filter:
                    if 'left' in effect_filter: effect_name = 'wipe-left'
                    elif 'right' in effect_filter: effect_name = 'wipe-right'
                    elif 'up' in effect_filter: effect_name = 'wipe-up'
                    elif 'down' in effect_filter: effect_name = 'wipe-down'
                    else: effect_name = 'wipe-right'
            elif pId == '9':
                effect_name = 'fade'
            elif pId == '22':
                if subType == '1': effect_name = 'wipe-down'
                elif subType == '2': effect_name = 'wipe-left'
                elif subType == '4': effect_name = 'wipe-right'
                elif subType == '8': effect_name = 'wipe-up'
                else: effect_name = 'wipe-right'
            elif pClass == 'exit':
                effect_name = 'fade-out'

            behaviours = ctn.findall('.//p:cBhvr', NS)
            if not behaviours:
                continue
            seen_in_ctn = set()
            for cBhvr in behaviours:
                tgt = cBhvr.find('p:tgtEl', NS)
                if tgt is None:
                    continue
                spTgt = tgt.find('p:spTgt', NS)
                if spTgt is None:
                    continue
                spid = spTgt.get('spid')
                if not spid:
                    continue
                txEl = spTgt.find('p:txEl', NS)
                p_range = None
                if txEl is not None:
                    pRg = txEl.find('p:pRg', NS)
                    if pRg is not None:
                        p_range = [int(pRg.get('st', 0)), int(pRg.get('end', pRg.get('st', 0)))]
                ctn_target_key = (spid, tuple(p_range) if p_range else None)
                if ctn_target_key in seen_in_ctn:
                    continue
                seen_in_ctn.add(ctn_target_key)
                rec = {
                    'spid': spid,
                    'para_range': p_range,
                    'type': pClass,
                    'kind': effect_kind,
                    'effect': effect_name,
                    'node_type': node_type,
                    'delay_ms': delay_ms,
                    'dur_ms': dur_ms,
                    'preset_id': pId,
                }
                rec.update(motion)
                flat.append((ctn_target_key, rec))

    if not flat:
        return None

    # Bucket into click steps: a clickEffect starts a new step once the current
    # one has content; withEffect / afterEffect join the active step.
    steps = []
    current = None
    for _, rec in flat:
        if rec['node_type'] == 'clickEffect' and (current is None or current['effects']):
            current = {'step': len(steps) + 1, 'effects': []}
            steps.append(current)
        if current is None:
            current = {'step': len(steps) + 1, 'effects': []}
            steps.append(current)
        current['effects'].append(rec)
    if not steps:
        return None

    # Compute cumulative intra-step delay_ms for chained afterEffect / withEffect actions.
    for step_obj in steps:
        cur_start_ms = 0
        cur_end_ms = 0
        for idx, eff in enumerate(step_obj['effects']):
            own_delay = eff.get('delay_ms', 0)
            dur = eff.get('dur_ms', 400)
            chain_dur = 20 if (eff.get('effect') in ('appear', 'disappear') and dur <= 10) else dur
            if idx == 0 or eff.get('node_type') == 'clickEffect':
                cur_start_ms = own_delay
                cur_end_ms = cur_start_ms + chain_dur
                eff['delay_ms'] = cur_start_ms
            elif eff.get('node_type') == 'afterEffect':
                cur_start_ms = cur_end_ms + own_delay
                cur_end_ms = cur_start_ms + chain_dur
                eff['delay_ms'] = cur_start_ms
            else:
                eff_start = cur_start_ms + own_delay
                cur_end_ms = max(cur_end_ms, eff_start + chain_dur)
                eff['delay_ms'] = eff_start

    # Paragraph build list (build="p") and diagram build info.
    builds = {}
    for b in root.findall('p:timing//p:bldLst/p:bldP', NS):
        builds[b.get('spid')] = {'build': b.get('build', 'whole'),
                                 'bldLvl': b.get('bldLvl'),
                                 'uiExpand': b.get('uiExpand')}
    return {'total_steps': len(steps), 'steps': steps, 'builds': builds}
def background(ctx, root, rels):
    bg = root.find('p:cSld/p:bg', NS)
    if bg is None:
        return None
    bgpr = bg.find('p:bgPr', NS)
    if bgpr is not None:
        return ctx.fill_of(bgpr, rels)
    ref = bg.find('p:bgRef', NS)
    if ref is not None:
        return {'type': 'solid', 'color': ctx.color_of(ref), 'from_theme_ref': True}
    return None


def load_theme(pkg, theme_part):
    colors, fonts, ln_styles = {}, {}, []
    th = pkg.xml(theme_part) if theme_part else None
    if th is not None:
        for c in th.find('.//a:clrScheme', NS):
            ch = c[0]
            colors[local(c)] = '#' + (ch.get('val') if local(ch) == 'srgbClr' else ch.get('lastClr', '000000')).lower()
        fs = th.find('.//a:fontScheme', NS)
        if fs is not None:
            fonts = {'+mj-lt': fs.find('a:majorFont/a:latin', NS).get('typeface'),
                     '+mn-lt': fs.find('a:minorFont/a:latin', NS).get('typeface')}
        fmt = th.find('.//a:fmtScheme', NS)
        if fmt is not None:
            for ln in fmt.findall('a:lnStyleLst/a:ln', NS):
                # theme line widths are EMU; convert via a temporary scale below
                ln_styles.append(int(ln.get('w', '12700')))
    return colors, fonts, ln_styles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pptx')
    ap.add_argument('--out', default='pptx-extract')
    ap.add_argument('--width', type=int, default=1920, help='target canvas width in px')
    ap.add_argument('--render', action='store_true', help='rasterise slides via LibreOffice + pdftoppm')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    pkg = Pkg(args.pptx)
    ctx = Ctx(pkg, args.width, args.out)
    full_tf = ()

    # A deck can contain SEVERAL slide masters, each with its own theme, colour map,
    # text styles and decor. Everything below is resolved per master.
    masters = {}

    def activate(mpart):
        """Switch ctx to the theme/colour map of a master and return its record."""
        m = masters.get(mpart)
        if m is None:
            root = pkg.xml(mpart)
            mrels = pkg.rels(mpart)
            theme_part = next((r['target'] for r in mrels.values() if r['type'] == 'theme'), None)
            colors, fonts, ln_emu = load_theme(pkg, theme_part)
            clrmap = dict(DEFAULT_CLRMAP)
            cm = root.find('p:clrMap', NS)
            if cm is not None:
                clrmap.update(dict(cm.attrib))
            tx = root.find('p:txStyles', NS)
            m = {'part': mpart, 'root': root, 'rels': mrels, 'colors': colors, 'fonts': fonts, 'clrmap': clrmap,
                 'ln_styles': [ctx.px(w) for w in ln_emu],
                 'txstyles': {local(c): c for c in tx} if tx is not None else {}}
            masters[mpart] = m
            ctx.theme, ctx.fonts, ctx.clrmap, ctx.theme_ln_styles = colors, fonts, clrmap, m['ln_styles']
            shapes = []
            walk_tree(ctx, root.find('p:cSld/p:spTree', NS), mrels, None, root, full_tf, 'master', m['txstyles'], shapes)
            # master placeholders (title, body...) are templates, not decor: drop them
            m['decor_shapes'] = [x for x in shapes if 'placeholder' not in x]
            m['background'] = background(ctx, root, mrels)
        ctx.theme, ctx.fonts, ctx.clrmap, ctx.theme_ln_styles = m['colors'], m['fonts'], m['clrmap'], m['ln_styles']
        return m

    layouts = {}

    def load_layout(part):
        if part in layouts:
            return layouts[part]
        root = pkg.xml(part)
        lrels = pkg.rels(part)
        mpart = next(r['target'] for r in lrels.values() if r['type'] == 'slideMaster')
        m = activate(mpart)
        shapes = []
        walk_tree(ctx, root.find('p:cSld/p:spTree', NS), lrels, None, m['root'], full_tf, 'layout', m['txstyles'], shapes)
        shapes = [x for x in shapes if 'placeholder' not in x]
        layouts[part] = {
            'name': root.find('p:cSld', NS).get('name', ''),
            'master': mpart,
            'show_master_shapes': root.get('showMasterSp', '1') != '0',
            'background': background(ctx, root, lrels),
            'decor_shapes': shapes,
            '_root': root,
        }
        return layouts[part]

    # slides in presentation order
    slides_out = []
    for i, sid in enumerate(ctx.pres.findall('p:sldIdLst/p:sldId', NS), 1):
        part = ctx.pres_rels[sid.get(q('r', 'id'))]['target']
        root = pkg.xml(part)
        rels = pkg.rels(part)
        layout_part = next((r['target'] for r in rels.values() if r['type'] == 'slideLayout'), None)
        layout = load_layout(layout_part)
        m = activate(layout['master'])
        shapes = []
        walk_tree(ctx, root.find('p:cSld/p:spTree', NS), rels, layout['_root'], m['root'], full_tf, 'slide', m['txstyles'], shapes)
        notes = None
        nrel = next((r['target'] for r in rels.values() if r['type'] == 'notesSlide'), None)
        if nrel:
            nroot = pkg.xml(nrel)
            lines = []
            for sp in nroot.iter(q('p', 'sp')):
                ph = ph_of(sp)
                if ph and ph['type'] == 'body':
                    for p in sp.findall('p:txBody/a:p', NS):
                        lines.append(''.join(t.text or '' for t in p.iter(q('a', 't'))))
            notes = '\n'.join(lines).strip() or None
        title = next((''.join(r['text'] for p in s['text']['paragraphs'] for r in p.get('runs', []))
                      for s in shapes if s.get('placeholder') in ('title', 'ctrTitle') and 'text' in s), '')
        own_bg = background(ctx, root, rels)
        slides_out.append({
            'number': i,
            'source_part': part,
            'title': title.strip(),
            'layout': layout_part,
            'master': layout['master'],
            'show_master_shapes': root.get('showMasterSp', '1') != '0' and layout['show_master_shapes'],
            'hidden': root.get('show') == '0',
            'background': own_bg,
            'effective_background': own_bg or layout['background'] or m['background'],
            'notes': notes,
            'animations': parse_slide_timing(root, ctx),
            'shapes': shapes,
        })

    for l in layouts.values():
        l.pop('_root', None)

    out_masters = {}
    for k, m in masters.items():
        out_masters[k] = {'theme': {'colors': m['colors'],
                                    'fonts': {'heading': m['fonts'].get('+mj-lt'), 'body': m['fonts'].get('+mn-lt')},
                                    'color_map': m['clrmap']},
                          'background': m['background'], 'decor_shapes': m['decor_shapes']}
    result = {
        'source': os.path.basename(args.pptx),
        'canvas': {'width': ctx.canvas_w, 'height': ctx.canvas_h, 'source_emu': [ctx.cx, ctx.cy],
                   'note': 'All x/y/w/h/size_px values are in this canvas coordinate system.'},
        'masters': out_masters,
        'layouts': layouts,
        'slides': slides_out,
    }
    with open(os.path.join(args.out, 'extract.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print('Wrote %s (%d slides, %d masters, %d layouts, %d media files, canvas %dx%d)' % (
        os.path.join(args.out, 'extract.json'), len(slides_out), len(masters), len(layouts), len(ctx.media),
        ctx.canvas_w, ctx.canvas_h))

    if args.render:
        soffice = shutil.which('soffice') or shutil.which('libreoffice')
        ppm = shutil.which('pdftoppm')
        if not (soffice and ppm):
            print('WARN: --render needs LibreOffice (soffice) and pdftoppm; skipping reference images', file=sys.stderr)
            return
        ref = os.path.join(args.out, 'reference')
        os.makedirs(ref, exist_ok=True)
        subprocess.run([soffice, '--headless', '--convert-to', 'pdf', '--outdir', ref, args.pptx], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pdf = os.path.join(ref, os.path.splitext(os.path.basename(args.pptx))[0] + '.pdf')
        subprocess.run([ppm, '-png', '-r', '80', pdf, os.path.join(ref, 'slide')], check=True)
        print('Rendered reference images to', ref)


if __name__ == '__main__':
    main()
