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
}
EMU_PER_PT = 12700
DEFAULT_CLRMAP = {'bg1': 'lt1', 'tx1': 'dk1', 'bg2': 'lt2', 'tx2': 'dk2'}


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
        final, i = name, 1
        while final in self.media.values():
            final = '%s_%d%s' % (base, i, ext)
            i += 1
        os.makedirs(os.path.join(self.out_dir, 'media'), exist_ok=True)
        with open(os.path.join(self.out_dir, 'media', final), 'wb') as f:
            f.write(self.pkg.z.read(zip_path))
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
        return {'color': col, 'width_px': self.px(int(ln.get('w', '12700'))), 'dash': d.get('val') if d is not None else 'solid'}


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
    if el.find('a:buNone', NS) is not None:
        o['bullet'] = None
    elif el.find('a:buChar', NS) is not None:
        o['bullet'] = el.find('a:buChar', NS).get('char')
    elif el.find('a:buAutoNum', NS) is not None:
        o['bullet'] = 'auto:' + el.find('a:buAutoNum', NS).get('type', 'arabicPeriod')
    bc = ctx.color_of(el.find('a:buClr', NS))
    if bc:
        o['bullet_color'] = bc
    return o


def lvl_style(ctx, sources, lvl):
    """Merge lvlNpPr (+defRPr) across inheritance sources (lowest priority first)."""
    ppr, rpr = {}, {}
    for src in sources:
        if src is None:
            continue
        el = src.find('a:lvl%dpPr' % (lvl + 1), NS)
        if el is None:
            continue
        ppr.update(ppr_props(ctx, el))
        rpr.update(rpr_props(ctx, el.find('a:defRPr', NS)))
    return ppr, rpr


def parse_text(ctx, txbody, sources, rels):
    if txbody is None:
        return None
    paras = []
    for p in txbody.findall('a:p', NS):
        pel = p.find('a:pPr', NS)
        lvl = int(pel.get('lvl', '0')) if pel is not None else 0
        ppr, base_rpr = lvl_style(ctx, sources, lvl)
        ppr.update(ppr_props(ctx, pel))
        runs = []
        for ch in p:
            n = local(ch)
            if n in ('r', 'fld'):
                t = ch.find('a:t', NS)
                rpr = dict(base_rpr)
                rpr.update(rpr_props(ctx, ch.find('a:rPr', NS)))
                run = {'text': t.text if t is not None and t.text else ''}
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
    body = txbody.find('a:bodyPr', NS)
    info = {}
    if body is not None:
        for k in ('anchor', 'wrap', 'vert'):
            if body.get(k):
                info[k] = body.get(k)
        for k, key in (('lIns', 'pad_left'), ('tIns', 'pad_top'), ('rIns', 'pad_right'), ('bIns', 'pad_bottom')):
            if body.get(k) is not None:
                info[key] = ctx.px(body.get(k))
        na = body.find('a:normAutofit', NS)
        if na is not None:
            info['autofit'] = {'font_scale_pct': int(na.get('fontScale', '100000')) / 1000}
        elif body.find('a:spAutoFit', NS) is not None:
            info['autofit'] = 'shape'
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


def apply_group(tf, x, y, w, h):
    gx, gy, sx, sy = tf
    return gx + (x) * sx, gy + (y) * sy, w * sx, h * sy


def parse_shape(ctx, sp, rels, chain, tf, source, master_txstyles):
    """chain: [master_sp, layout_sp] inheritance elements for placeholders (may be None)."""
    kind = local(sp)
    nvpr, cnv = nv_pr(sp)
    ph = ph_of(sp)
    name = cnv.get('name') if cnv is not None else ''
    out = {'name': name, 'kind': kind}
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
    if xf is not None and xf.find('a:off', NS) is not None:
        off, ext = xf.find('a:off', NS), xf.find('a:ext', NS)
        x, y, w, h = int(off.get('x')), int(off.get('y')), int(ext.get('cx')), int(ext.get('cy'))
        gx, gy, sx, sy = tf
        out['x'], out['y'] = ctx.px(gx + x * sx), ctx.px(gy + y * sy)
        out['w'], out['h'] = ctx.px(w * sx), ctx.px(h * sy)
        if xf.get('rot'):
            out['rotation_deg'] = int(xf.get('rot')) / 60000
        if xf.get('flipH') == '1':
            out['flipH'] = True
        if xf.get('flipV') == '1':
            out['flipV'] = True

    sppr = sp.find('p:spPr', NS)
    if kind == 'sp':
        geom = sppr.find('a:prstGeom', NS) if sppr is not None else None
        out['geometry'] = geom.get('prst') if geom is not None else ('custom' if sppr is not None and sppr.find('a:custGeom', NS) is not None else 'rect')
        if geom is not None:
            adj = {g.get('name'): g.get('fmla') for g in geom.findall('a:avLst/a:gd', NS)}
            if adj:
                out['geometry_adjust'] = adj
        fill = ctx.fill_of(sppr, rels)
        if fill is None and chain:
            for anc in reversed(chain):
                if anc is not None:
                    fill = ctx.fill_of(anc.find('p:spPr', NS), rels)
                    if fill:
                        break
        if fill:
            out['fill'] = fill
        ln = ctx.line_of(sppr)
        if ln:
            out['line'] = ln
        st = sp.find('p:style', NS)
        if st is not None and fill is None:
            fr = st.find('a:fillRef', NS)
            if fr is not None and fr.get('idx') not in (None, '0'):
                out['fill_from_style'] = ctx.color_of(fr)
        if sppr is not None and sppr.find('a:effectLst/a:outerShdw', NS) is not None:
            out['shadow'] = True
        # text
        srcs = []
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
        text = parse_text(ctx, sp.find('p:txBody', NS), srcs, rels)
        if text and any(not p.get('empty') for p in text['paragraphs']):
            out['text'] = text
        elif text and (fill or ln) is None and not ph:
            return None
        elif text:
            out['text'] = text  # keep empty paragraphs' styling for filled shapes
        if not ph and 'text' not in out and not out.get('fill') and not out.get('line') and not out.get('fill_from_style'):
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
        ln = ctx.line_of(sppr)
        if ln:
            out['line'] = ln
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
        ln = ctx.line_of(sppr)
        if not ln:
            return None
        out['line'] = ln
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


def walk_tree(ctx, tree, rels, layout_root, master_root, tf, source, master_txstyles, out):
    for sp in tree:
        n = local(sp)
        if n in ('sp', 'pic', 'graphicFrame', 'cxnSp'):
            chain = None
            ph = ph_of(sp) if n != 'cxnSp' else None
            if ph and source == 'slide':
                chain = [find_ph(master_root, ph), find_ph(layout_root, ph)]
            res = parse_shape(ctx, sp, rels, chain, tf, source, master_txstyles)
            if res:
                out.append(res)
        elif n == 'grpSp':
            xf = sp.find('p:grpSpPr/a:xfrm', NS)
            ntf = tf
            if xf is not None and xf.find('a:chExt', NS) is not None:
                off, ext = xf.find('a:off', NS), xf.find('a:ext', NS)
                choff, chext = xf.find('a:chOff', NS), xf.find('a:chExt', NS)
                cw, ch = int(chext.get('cx')) or 1, int(chext.get('cy')) or 1
                sx, sy = int(ext.get('cx')) / cw, int(ext.get('cy')) / ch
                gx = tf[0] + (int(off.get('x')) - int(choff.get('x')) * sx) * tf[2]
                gy = tf[1] + (int(off.get('y')) - int(choff.get('y')) * sy) * tf[3]
                ntf = (gx, gy, sx * tf[2], sy * tf[3])
            walk_tree(ctx, sp, rels, layout_root, master_root, ntf, source, master_txstyles, out)


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

    # theme
    theme_part = next((r['target'] for r in ctx.pres_rels.values() if r['type'] == 'theme'), 'ppt/theme/theme1.xml')
    th = pkg.xml(theme_part)
    if th is not None:
        for c in th.find('.//a:clrScheme', NS):
            n = local(c)
            ch = c[0]
            ctx.theme[n] = '#' + (ch.get('val') if local(ch) == 'srgbClr' else ch.get('lastClr', '000000')).lower()
        fs = th.find('.//a:fontScheme', NS)
        if fs is not None:
            major = fs.find('a:majorFont/a:latin', NS).get('typeface')
            minor = fs.find('a:minorFont/a:latin', NS).get('typeface')
            ctx.fonts = {'+mj-lt': major, '+mn-lt': minor}

    # masters / layouts
    master_part = next((r['target'] for r in pkg.rels('ppt/presentation.xml').values() if r['type'] == 'slideMaster'), None)
    master = pkg.xml(master_part)
    ctx.master_root = master
    cm = master.find('p:clrMap', NS)
    if cm is not None:
        ctx.clrmap.update({k: v for k, v in cm.attrib.items()})
    master_rels = pkg.rels(master_part)
    tx = master.find('p:txStyles', NS)
    master_txstyles = {local(c): c for c in tx} if tx is not None else {}

    full_tf = (0, 0, 1, 1)
    master_shapes = []
    walk_tree(ctx, master.find('p:cSld/p:spTree', NS), master_rels, None, master, full_tf, 'master', master_txstyles, master_shapes)
    # master placeholders (title, body...) are templates, not decor: drop them
    master_shapes = [s for s in master_shapes if 'placeholder' not in s]

    layouts = {}

    def load_layout(part):
        if part in layouts:
            return layouts[part]
        root = pkg.xml(part)
        lrels = pkg.rels(part)
        shapes = []
        walk_tree(ctx, root.find('p:cSld/p:spTree', NS), lrels, None, master, full_tf, 'layout', master_txstyles, shapes)
        shapes = [s for s in shapes if 'placeholder' not in s]
        layouts[part] = {
            'name': root.find('p:cSld', NS).get('name', ''),
            'show_master_shapes': root.get('showMasterSp', '1') != '0',
            'background': background(ctx, root, lrels),
            'decor_shapes': shapes,
            '_root': root,
        }
        return layouts[part]

    # slides in presentation order
    slides_out = []
    sld_ids = ctx.pres.findall('p:sldIdLst/p:sldId', NS)
    for i, sid in enumerate(sld_ids, 1):
        part = ctx.pres_rels[sid.get(q('r', 'id'))]['target']
        root = pkg.xml(part)
        rels = pkg.rels(part)
        layout_part = next((r['target'] for r in rels.values() if r['type'] == 'slideLayout'), None)
        layout = load_layout(layout_part) if layout_part else None
        shapes = []
        walk_tree(ctx, root.find('p:cSld/p:spTree', NS), rels, layout['_root'] if layout else None, master, full_tf, 'slide', master_txstyles, shapes)
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
        slides_out.append({
            'number': i,
            'source_part': part,
            'title': title.strip(),
            'layout': layout_part,
            'show_master_shapes': root.get('showMasterSp', '1') != '0' and (layout['show_master_shapes'] if layout else True),
            'hidden': root.get('show') == '0',
            'background': background(ctx, root, rels),
            'effective_background': background(ctx, root, rels) or (layout['background'] if layout else None) or background(ctx, master, master_rels),
            'notes': notes,
            'shapes': shapes,
        })

    for l in layouts.values():
        l.pop('_root', None)

    result = {
        'source': os.path.basename(args.pptx),
        'canvas': {'width': ctx.canvas_w, 'height': ctx.canvas_h, 'source_emu': [ctx.cx, ctx.cy],
                   'note': 'All x/y/w/h/size_px values are in this canvas coordinate system.'},
        'theme': {'colors': ctx.theme, 'fonts': {'heading': ctx.fonts.get('+mj-lt'), 'body': ctx.fonts.get('+mn-lt')},
                  'color_map': ctx.clrmap},
        'master': {'background': background(ctx, master, master_rels), 'decor_shapes': master_shapes},
        'layouts': layouts,
        'slides': slides_out,
    }
    with open(os.path.join(args.out, 'extract.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print('Wrote %s (%d slides, %d media files, canvas %dx%d)' % (
        os.path.join(args.out, 'extract.json'), len(slides_out), len(ctx.media), ctx.canvas_w, ctx.canvas_h))

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
