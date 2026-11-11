#!/usr/bin/env python3
"""
visual_compare.py - NeoPowerPoint visual fidelity harness.

Renders ground-truth slide images from a .pptx (LibreOffice + pdftoppm), captures
the generated NeoPowerPoint HTML slides at the exact canvas size (Chromium
headless), audits DOM geometry for overflows / text overlaps / broken media, and
produces SSIM metrics + side-by-side diff images + an interactive HTML report.

Usage:
  python3 scripts/visual_compare.py deck.pptx
  python3 scripts/visual_compare.py deck.pptx --deck ./my-deck
  python3 scripts/visual_compare.py deck.pptx --slides 1,4,9-12 --steps

Dependencies:
  - python3 (stdlib), Pillow + numpy for image metrics (optional but recommended)
  - soffice + pdftoppm for reference rasters
  - chromium (or google-chrome / chromium-browser) for HTML captures
"""

import argparse
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONVERTER = ROOT / 'src' / 'converter'


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def which_any(*names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def run(cmd, **kw):
    kw.setdefault('check', True)
    kw.setdefault('stdout', subprocess.DEVNULL)
    kw.setdefault('stderr', subprocess.DEVNULL)
    return subprocess.run(cmd, **kw)


def parse_slide_filter(spec, total):
    if not spec:
        return None
    picked = set()
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            a, b = part.split('-', 1)
            picked.update(range(int(a), int(b) + 1))
        else:
            picked.add(int(part))
    return {n for n in picked if 1 <= n <= total}


def slug(s):
    s = re.sub(r'[^a-zA-Z0-9]+', '-', (s or 'slide').lower()).strip('-')
    return s[:48] or 'slide'


# --------------------------------------------------------------------------- #
# 1. conversion + ground truth
# --------------------------------------------------------------------------- #
def convert(pptx, work, deck_dir=None):
    extract_dir = work / 'extract'
    if deck_dir is None:
        deck_dir = work / 'deck'
        extract_dir.mkdir(parents=True, exist_ok=True)
        print('[1/5] Extracting PPTX ...')
        run([sys.executable, str(CONVERTER / 'extract_pptx.py'), str(pptx), '--out', str(extract_dir)])
        print('[2/5] Generating NeoPowerPoint deck ...')
        deck_dir.mkdir(parents=True, exist_ok=True)
        run([sys.executable, str(CONVERTER / 'generate_deck.py'),
             '--extract', str(extract_dir / 'extract.json'), '--out', str(deck_dir)])
    else:
        # The deck exists, but hidden-slide mapping needs the extracted slide list.
        if not (extract_dir / 'extract.json').exists():
            extract_dir.mkdir(parents=True, exist_ok=True)
            print('[1/5] Extracting PPTX metadata ...')
            run([sys.executable, str(CONVERTER / 'extract_pptx.py'), str(pptx), '--out', str(extract_dir)])
    return Path(deck_dir), extract_dir


def reference_fontconfig(out):
    """Map Windows core fonts to the metric-compatible fonts installed locally.

    LibreOffice otherwise substitutes DejaVu/Liberation Sans, whose wider metrics
    make the ground-truth raster disagree with the actual generated deck.
    """
    conf = out / 'fontconfig.conf'
    conf.write_text("""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <alias binding="same"><family>Calibri</family><prefer><family>Carlito</family></prefer></alias>
  <alias binding="same"><family>Calibri Light</family><prefer><family>Carlito</family></prefer></alias>
  <alias binding="same"><family>Cambria</family><prefer><family>Caladea</family></prefer></alias>
  <alias binding="same"><family>Arial</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias binding="same"><family>Helvetica</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias binding="same"><family>Times New Roman</family><prefer><family>Liberation Serif</family></prefer></alias>
  <alias binding="same"><family>Courier New</family><prefer><family>Liberation Mono</family></prefer></alias>
</fontconfig>
""", encoding='utf-8')
    env = os.environ.copy()
    env['FONTCONFIG_FILE'] = str(conf)
    return env


def render_reference(pptx, extract_dir, out, width, height, dpi):
    """LibreOffice -> PDF -> PNGs, resized to the NeoPowerPoint canvas."""
    out.mkdir(parents=True, exist_ok=True)
    images = sorted(out.glob('slide-*.png'))
    if not images:
        soffice = which_any('soffice', 'libreoffice')
        ppm = which_any('pdftoppm')
        if not (soffice and ppm):
            print('WARN: soffice/pdftoppm missing - cannot render ground truth', file=sys.stderr)
            return []
        print('[3/5] Rendering ground-truth slides via LibreOffice ...')
        try:
            env = reference_fontconfig(out)
        except OSError:
            env = None
        run([soffice, '--headless', '--convert-to', 'pdf', '--outdir', str(out), str(pptx)], env=env)
        pdfs = sorted(out.glob('*.pdf'))
        if not pdfs:
            print('WARN: LibreOffice produced no PDF', file=sys.stderr)
            return []
        prefix = out / 'ref'
        run([ppm, '-png', '-r', str(dpi), str(pdfs[0]), str(prefix)])
        rendered = sorted(out.glob('ref-*.png'))
        for i, f in enumerate(rendered, 1):
            f.rename(out / f'slide-{i:03d}.png')
        for p in pdfs:
            p.unlink(missing_ok=True)
    else:
        print('[3/5] Reusing existing reference images ...')

    try:
        from PIL import Image
    except ImportError:
        print('WARN: Pillow missing - reference images not resized', file=sys.stderr)
        return sorted(out.glob('slide-*.png'))
    for f in sorted(out.glob('slide-*.png')):
        im = Image.open(f).convert('RGB')
        if im.size != (width, height):
            im.resize((width, height), Image.LANCZOS).save(f)
    return sorted(out.glob('slide-*.png'))


# --------------------------------------------------------------------------- #
# 2. browser capture + DOM audit
# --------------------------------------------------------------------------- #
CHROME = None


def browser_bin():
    global CHROME
    if CHROME is None:
        CHROME = which_any('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable')
        if not CHROME:
            raise SystemExit('ERROR: no Chromium/Chrome binary found on PATH')
    return CHROME


AUDIT_JS = r"""
(function () {
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function overlap(a, b) {
    var x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    var y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x * y;
  }
  function spid(el) {
    var n = el.closest('[data-spid]');
    return n ? (n.getAttribute('data-spid') || '') : '';
  }
  function shapeOf(el) {
    return el.closest('[data-spid]');
  }
  function paintsLater(a, b) {
    // Returns the element painted on top (DOM order is the paint order here).
    var pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return b;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return a;
    return b;
  }
  function isOpaque(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toUpperCase();
    if (tag === 'IMG' || tag === 'SVG') return true;
    var cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    var bg = cs.backgroundColor || '';
    var m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    var parts = m[1].split(',').map(parseFloat);
    var alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.9;
  }
  function occludedAt(aEl, bEl, inter) {
    // True when an opaque shape/callout sits *between* the two text elements in
    // paint order at the overlap point (white speech bubbles over DHCP detail
    // boxes, diagram labels, ...). Those overlaps are intentional.
    var x = (inter.x0 + inter.x1) / 2;
    var y = (inter.y0 + inter.y1) / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    var stack = document.elementsFromPoint(x, y);
    var ia = -1, ib = -1;
    for (var i = 0; i < stack.length; i++) {
      if (ia < 0 && (stack[i] === aEl || stack[i].contains(aEl))) ia = i;
      if (ib < 0 && (stack[i] === bEl || stack[i].contains(bEl))) ib = i;
    }
    if (ia < 0 || ib < 0) return false;
    var lo = Math.max(ia, ib), hi = Math.min(ia, ib);
    for (var j = hi + 1; j < lo; j++) {
      if (isOpaque(stack[j])) return true;
    }
    return false;
  }
  function audit() {
    var out = { overflow: [], overlaps: [], brokenMedia: [], counts: {} };

    var slideEl = document.querySelector('.slide-container') || document.body;
    var canvasRect = slideEl.getBoundingClientRect();
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.tb'));
    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      if (!visible(el)) continue;
      var overflowY = el.scrollHeight - el.clientHeight;
      var overflowX = el.scrollWidth - el.clientWidth;
      var rect = el.getBoundingClientRect();
      var outside = Math.max(0, rect.bottom - canvasRect.bottom, rect.right - canvasRect.right);
      if (overflowY > 4 || overflowX > 4 || outside > 3) {
        out.overflow.push({
          spid: spid(el),
          name: (el.getAttribute('data-name') || ''),
          overflowX: Math.round(overflowX),
          overflowY: Math.round(overflowY),
          outsideCanvas: Math.round(outside),
          text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 140)
        });
      }
    }

    var paras = Array.prototype.slice.call(document.querySelectorAll('.tb p')).filter(function (p) {
      return (p.innerText || '').trim().length > 0 && visible(p);
    });
    if (paras.length > 700) paras = paras.slice(0, 700);
    var rects = paras.map(function (p) { return { el: p, r: p.getBoundingClientRect(), id: spid(p) }; });
    for (var a = 0; a < rects.length; a++) {
      for (var b = a + 1; b < rects.length; b++) {
        if (rects[a].id === rects[b].id) continue;
        var areaA = rects[a].r.width * rects[a].r.height;
        var areaB = rects[b].r.width * rects[b].r.height;
        if (areaA < 4 || areaB < 4) continue;
        var ov = overlap(rects[a].r, rects[b].r);
        if (ov / Math.min(areaA, areaB) > 0.15) {
          var ra = rects[a].r, rb = rects[b].r;
          var inter = {
            x0: Math.max(ra.left, rb.left), y0: Math.max(ra.top, rb.top),
            x1: Math.min(ra.right, rb.right), y1: Math.min(ra.bottom, rb.bottom)
          };
          if (occludedAt(rects[a].el, rects[b].el, inter)) continue;
          out.overlaps.push({
            a: { spid: rects[a].id, text: (rects[a].el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 90) },
            b: { spid: rects[b].id, text: (rects[b].el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 90) },
            ratio: +(ov / Math.min(areaA, areaB)).toFixed(2)
          });
          if (out.overlaps.length >= 60) break;
        }
      }
      if (out.overlaps.length >= 60) break;
    }

    var imgs = Array.prototype.slice.call(document.images);
    for (var k = 0; k < imgs.length; k++) {
      if (imgs[k].complete && imgs[k].naturalWidth === 0) {
        out.brokenMedia.push({ type: 'img', src: imgs[k].getAttribute('src') || '' });
      }
    }
    var svgs = Array.prototype.slice.call(document.querySelectorAll('svg'));
    for (var s = 0; s < svgs.length; s++) {
      var r = svgs[s].getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        out.brokenMedia.push({ type: 'svg', cls: svgs[s].getAttribute('class') || '' });
      }
    }
    out.counts = {
      textBoxes: boxes.length,
      paragraphs: paras.length,
      overflow: out.overflow.length,
      overlaps: out.overlaps.length,
      brokenMedia: out.brokenMedia.length
    };
    out.overflow = out.overflow.slice(0, 40);
    out.brokenMedia = out.brokenMedia.slice(0, 20);
    return out;
  }
  function publish() {
    var data;
    try {
      data = audit();
    } catch (e) {
      data = { error: String(e), overflow: [], overlaps: [], brokenMedia: [], counts: {} };
    }
    var tag = document.getElementById('neo-audit-data');
    if (!tag) {
      tag = document.createElement('script');
      tag.type = 'application/json';
      tag.id = 'neo-audit-data';
      document.body.appendChild(tag);
    }
    tag.textContent = JSON.stringify(data);
  }
  // Publish early and often: Chromium's --dump-dom may fire at the virtual-time
  // budget before the load event on image/font-heavy slides.
  setTimeout(publish, 50);
  setTimeout(publish, 500);
  setTimeout(publish, 2000);
  window.addEventListener('load', function () {
    publish();
    requestAnimationFrame(function () { publish(); });
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { setTimeout(publish, 0); });
  }
})();
"""


# Chromium's legacy headless window keeps ~87px of (invisible) window frame in
# --window-size, so the screenshot is padded with white below the real viewport.
# Ask for a taller window and crop the screenshot back to the requested canvas.
CHROME_VIEWPORT_MARGIN = 120


def crop_png(path, width, height):
    try:
        from PIL import Image
    except ImportError:
        return
    try:
        im = Image.open(path)
        if im.size != (width, height):
            im.crop((0, 0, width, height)).save(path)
    except Exception as exc:  # noqa: BLE001 - capture must not fail on crop
        print(f'  WARN: could not crop {path}: {exc}', file=sys.stderr)


def capture_slide(slide_path, out_png, width, height, extra_hash='#showall', audit=False):
    url = slide_path.resolve().as_uri() + (extra_hash or '')
    window_arg = f'--window-size={width},{height + CHROME_VIEWPORT_MARGIN}'
    tmp = None
    if audit:
        tmp = slide_path.parent / ('__neo_audit_' + slide_path.stem + '.html')
        content = slide_path.read_text(encoding='utf-8', errors='replace')
        content = content.replace('</body>', f'<script>{AUDIT_JS}</script>\n</body>')
        tmp.write_text(content, encoding='utf-8')
        url = tmp.resolve().as_uri() + (extra_hash or '')
    try:
        if audit:
            for attempt in range(3):
                dump = subprocess.run(
                    [browser_bin(), '--headless', '--disable-gpu', '--no-sandbox',
                     '--hide-scrollbars', '--virtual-time-budget=5000',
                     window_arg, '--dump-dom', url],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90)
                m = re.search(r'<script[^>]*id="neo-audit-data"[^>]*>(.*?)</script>',
                              dump.stdout.decode('utf-8', 'replace'), re.S)
                if m:
                    data = json.loads(html.unescape(m.group(1)))
                    if not data.get('error'):
                        return data
            print(f'  WARN: DOM audit produced no result for {slide_path.parent.name}', file=sys.stderr)
            return None
        run([browser_bin(), '--headless', '--disable-gpu', '--no-sandbox',
             '--hide-scrollbars', window_arg,
             f'--screenshot={out_png}', url], timeout=90)
        crop_png(out_png, width, height)
        return None
    except subprocess.TimeoutExpired:
        print(f'  WARN: timeout capturing {slide_path.name}', file=sys.stderr)
        return None
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# 3. image metrics
# --------------------------------------------------------------------------- #
def _box_blur(x, radius):
    """Fast uniform box blur via integral image (2D numpy array)."""
    import numpy as np
    r = int(radius)
    pad = np.pad(x, r, mode='edge')
    ii = pad.cumsum(0).cumsum(1)
    ii = np.pad(ii, ((1, 0), (1, 0)))
    h, w = x.shape
    k = 2 * r + 1
    out = (ii[k:k + h, k:k + w] - ii[0:h, k:k + w] - ii[k:k + h, 0:w] + ii[0:h, 0:w]) / (k * k)
    return out


def image_metrics(ref_path, neo_path):
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return {'ssim': None, 'mae': None, 'error': 'Pillow/numpy not installed'}

    ref = Image.open(ref_path).convert('RGB')
    neo = Image.open(neo_path).convert('RGB')
    if ref.size != neo.size:
        neo = neo.resize(ref.size, Image.LANCZOS)
    # Compare at a smaller scale: robust to antialiasing and much faster.
    scale = 3
    small_ref = ref.resize((max(1, ref.width // scale), max(1, ref.height // scale)), Image.LANCZOS)
    small_neo = neo.resize(small_ref.size, Image.LANCZOS)
    a = np.asarray(small_ref, dtype=np.float64)
    b = np.asarray(small_neo, dtype=np.float64)
    mae = float(np.mean(np.abs(a - b)) / 255.0)

    ga = a.mean(axis=2)
    gb = b.mean(axis=2)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a = _box_blur(ga, 3)
    mu_b = _box_blur(gb, 3)
    va = _box_blur(ga * ga, 3) - mu_a ** 2
    vb = _box_blur(gb * gb, 3) - mu_b ** 2
    cov = _box_blur(ga * gb, 3) - mu_a * mu_b
    ssim_map = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / (
        (mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2))
    ssim = float(np.mean(ssim_map))
    bad_ratio = float(np.mean(np.abs(a - b).max(axis=2) > 48))
    return {'ssim': round(ssim, 5), 'mae': round(mae, 5), 'diff_area': round(bad_ratio, 4)}


def write_diff_image(ref_path, neo_path, out_path):
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return
    ref = Image.open(ref_path).convert('RGB')
    neo = Image.open(neo_path).convert('RGB')
    if ref.size != neo.size:
        neo = neo.resize(ref.size, Image.LANCZOS)
    a = np.asarray(ref, dtype=np.int16)
    b = np.asarray(neo, dtype=np.int16)
    diff = np.abs(a - b).max(axis=2)
    heat = np.zeros_like(a, dtype=np.uint8)
    heat[..., 0] = np.clip(diff * 3, 0, 255)
    overlay = (np.asarray(ref, dtype=np.float32) * 0.45 + heat.astype(np.float32) * 0.55).astype(np.uint8)
    h = ref.height
    composite = Image.new('RGB', (ref.width * 3 + 16, h), 'white')
    composite.paste(ref, (0, 0))
    composite.paste(neo, (ref.width + 8, 0))
    composite.paste(Image.fromarray(overlay), (ref.width * 2 + 16, 0))
    composite.save(out_path)


# --------------------------------------------------------------------------- #
# 4. report
# --------------------------------------------------------------------------- #
def write_report(results, out_dir, deck_dir, pptx):
    rows = sorted(results, key=lambda r: (r.get('ssim') if r.get('ssim') is not None else 9,
                                          r['audit'].get('counts', {}).get('overlaps', 0)))
    cards = []
    for r in rows:
        ssim = r.get('ssim')
        ssim_txt = f'{ssim:.3f}' if ssim is not None else 'n/a'
        cls = 'good' if ssim is None or ssim >= 0.88 else ('warn' if ssim >= 0.75 else 'bad')
        au = r['audit'].get('counts', {})
        thumb = r.get('diff_rel')
        overflow = ''.join(
            f'<li><code>{html.escape(o.get("spid", ""))}</code> '
            f'+{o.get("overflowY", 0)}px / outside {o.get("outsideCanvas", 0)}px '
            f'{html.escape(o.get("text", "")[:110])}</li>' for o in r['audit'].get('overflow', [])[:8])
        overlaps = ''.join(
            f'<li>{o.get("ratio")} &middot; <code>{html.escape(o["a"].get("spid", ""))}</code> '
            f'"{html.escape(o["a"].get("text", "")[:60])}" &harr; '
            f'<code>{html.escape(o["b"].get("spid", ""))}</code> '
            f'"{html.escape(o["b"].get("text", "")[:60])}"</li>' for o in r['audit'].get('overlaps', [])[:8])
        cards.append(f"""
<section class="card {cls}">
  <header><h2>Slide {r['visible_index']} &middot; {html.escape(r['title'])}</h2>
    <span class="score">SSIM {ssim_txt}</span></header>
  <div class="meta">MAE {r.get('mae', 'n/a')} &middot; diff area {r.get('diff_area', 'n/a')}
    &middot; overflow <b>{au.get('overflow', 0)}</b> &middot; overlaps <b>{au.get('overlaps', 0)}</b>
    &middot; broken media <b>{au.get('brokenMedia', 0)}</b></div>
  {f'<img class="diff" loading="lazy" src="{thumb}" alt="reference vs NeoPowerPoint vs diff">' if thumb else ''}
  {f'<details><summary>Text overflow ({au.get("overflow", 0)})</summary><ul>{overflow}</ul></details>' if overflow else ''}
  {f'<details><summary>Text overlaps ({au.get("overlaps", 0)})</summary><ul>{overlaps}</ul></details>' if overlaps else ''}
</section>""")
    avg = [r['ssim'] for r in results if r.get('ssim') is not None]
    avg_txt = f'{sum(avg) / len(avg):.4f}' if avg else 'n/a'
    total_over = sum(r['audit'].get('counts', {}).get('overflow', 0) for r in results)
    total_ov = sum(r['audit'].get('counts', {}).get('overlaps', 0) for r in results)
    doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>NeoPowerPoint visual report</title>
<style>
 body {{ font: 14px/1.5 system-ui, sans-serif; margin: 0; background:#0f172a; color:#e2e8f0; }}
 header.top {{ padding: 22px 28px; background:#111c33; border-bottom:1px solid #24324d; }}
 h1 {{ margin:0 0 4px; font-size:22px; }} .sub {{ color:#94a3b8; }}
 .summary {{ display:flex; gap:14px; flex-wrap:wrap; margin-top:12px; }}
 .pill {{ background:#1b2a45; border:1px solid #2c3e61; padding:5px 10px; border-radius:999px; }}
 main {{ padding: 20px 28px 60px; max-width: 1240px; margin:auto; }}
 .card {{ background:#152238; border:1px solid #263a5c; border-radius:10px; padding:14px 16px; margin:14px 0; }}
 .card.good {{ border-left:5px solid #22c55e; }} .card.warn {{ border-left:5px solid #eab308; }}
 .card.bad {{ border-left:5px solid #ef4444; }}
 .card h2 {{ font-size:15px; margin:0; }} .card header {{ display:flex; justify-content:space-between; gap:12px; }}
 .score {{ font-variant-numeric:tabular-nums; font-weight:600; }}
 .meta {{ color:#94a3b8; margin:6px 0 10px; }}
 img.diff {{ width:100%; border-radius:6px; background:#fff; }}
 details {{ margin-top:8px; }} summary {{ cursor:pointer; color:#93c5fd; }}
 li {{ margin:3px 0; font-size:13px; }} code {{ background:#0b1526; padding:1px 4px; border-radius:3px; }}
</style></head><body>
<header class="top">
  <h1>NeoPowerPoint visual fidelity report</h1>
  <div class="sub">{html.escape(Path(pptx).name)} &rarr; {html.escape(str(deck_dir))}</div>
  <div class="summary">
    <span class="pill">Slides: {len(results)}</span>
    <span class="pill">Mean SSIM: {avg_txt}</span>
    <span class="pill">Text overflow: {total_over}</span>
    <span class="pill">Text overlaps: {total_ov}</span>
  </div>
</header>
<main>{''.join(cards)}</main>
</body></html>"""
    (out_dir / 'report.html').write_text(doc, encoding='utf-8')
    return out_dir / 'report.html'


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pptx')
    ap.add_argument('--deck', help='Existing generated deck (skips extraction/generation)')
    ap.add_argument('--out', default=str(ROOT / 'test-output' / 'visual-compare'))
    ap.add_argument('--width', type=int, default=1920)
    ap.add_argument('--height', type=int, default=1080)
    ap.add_argument('--dpi', type=int, default=150)
    ap.add_argument('--slides', help='Only compare these source slide numbers, e.g. 1,4,9-12')
    ap.add_argument('--steps', action='store_true', help='Also capture animation step screenshots')
    ap.add_argument('--no-audit', action='store_true', help='Skip DOM geometry audit')
    ap.add_argument('--skip-ref', action='store_true', help='Reuse existing reference PNGs')
    ap.add_argument('--skip-capture', action='store_true', help='Reuse existing NeoPowerPoint captures')
    ap.add_argument('--keep-work', action='store_true', help='Keep temp extraction/deck when --deck is absent')
    args = ap.parse_args()

    pptx = Path(args.pptx).resolve()
    if not pptx.exists():
        raise SystemExit(f'ERROR: PPTX not found: {pptx}')
    out = Path(args.out).resolve()
    work = out / '_work'
    ref_dir = out / 'reference'
    neo_dir = out / 'neo'
    diff_dir = out / 'diff'
    step_dir = out / 'steps'
    for d in (ref_dir, neo_dir, diff_dir):
        d.mkdir(parents=True, exist_ok=True)

    deck_dir, extract_dir = convert(pptx, work, Path(args.deck).resolve() if args.deck else None)
    deck_json = json.loads((deck_dir / 'deck.json').read_text(encoding='utf-8'))
    extract = json.loads((extract_dir / 'extract.json').read_text(encoding='utf-8'))
    canvas = extract.get('canvas', {})
    width = args.width or canvas.get('width', 1920)
    height = canvas.get('height', 1080) if args.height == 1080 else args.height
    width, height = int(width), int(height)

    refs = [] if args.skip_ref else render_reference(pptx, extract_dir, ref_dir, width, height, args.dpi)
    if not refs:
        refs = sorted(ref_dir.glob('slide-*.png'))
    visible = [s for s in extract.get('slides', []) if not s.get('hidden')]
    manifest = deck_json.get('slides', [])
    pair_count = min(len(visible), len(manifest), len(refs)) if refs else min(len(visible), len(manifest))

    wanted = parse_slide_filter(args.slides, len(visible))
    results = []
    print(f'[4/5] Capturing {pair_count} slides at {width}x{height} ...')
    for i in range(pair_count):
        src = visible[i]
        src_no = int(src.get('number', i + 1))
        if wanted and src_no not in wanted:
            continue
        ms = manifest[i]
        slide_path = deck_dir / ms['path']
        if not slide_path.exists():
            print(f'  WARN: missing slide file {slide_path}', file=sys.stderr)
            continue
        tag = f'{src_no:03d}'
        neo_png = neo_dir / f'slide-{tag}.png'
        if not args.skip_capture:
            print(f'  - slide {src_no:03d}: {ms.get("title", "")[:60]}')
            capture_slide(slide_path, neo_png, width, height)
        audit = {}
        if not args.no_audit:
            audit = capture_slide(slide_path, None, width, height, audit=True) or {}
        rec = {
            'visible_index': i + 1,
            'source_slide': src_no,
            'title': ms.get('title', ''),
            'slide_path': ms['path'],
            'audit': audit,
        }
        ref_png = refs[i] if i < len(refs) else None
        if ref_png and neo_png.exists():
            rec.update(image_metrics(ref_png, neo_png))
            diff_png = diff_dir / f'slide-{tag}.png'
            write_diff_image(ref_png, neo_png, diff_png)
            rec['diff_rel'] = f'diff/{diff_png.name}'
        results.append(rec)

        if args.steps and src.get('animations'):
            total = int(src['animations'].get('total_steps', 0))
            sdir = step_dir / f'slide-{tag}'
            sdir.mkdir(parents=True, exist_ok=True)
            for k in range(total + 1):
                capture_slide(slide_path, sdir / f'step-{k:02d}.png', width, height,
                              extra_hash=f'#step={k}')
            (sdir / 'steps.json').write_text(json.dumps(
                [{'step': k, 'image': f'step-{k:02d}.png'} for k in range(total + 1)], indent=2))

    metrics = {
        'source': str(pptx),
        'deck': str(deck_dir),
        'canvas': {'width': width, 'height': height},
        'slides': results,
        'summary': {
            'slides': len(results),
            'mean_ssim': round(sum(r['ssim'] for r in results if r.get('ssim') is not None) /
                               max(1, sum(1 for r in results if r.get('ssim') is not None)), 5),
            'text_overflow': sum(r['audit'].get('counts', {}).get('overflow', 0) for r in results),
            'text_overlaps': sum(r['audit'].get('counts', {}).get('overlaps', 0) for r in results),
            'broken_media': sum(r['audit'].get('counts', {}).get('brokenMedia', 0) for r in results),
        },
    }
    (out / 'metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
    print('[5/5] Writing report ...')
    report = write_report(results, out, deck_dir, pptx)
    s = metrics['summary']
    print(f"\nMean SSIM: {s['mean_ssim']}  |  overflow: {s['text_overflow']}  "
          f"|  overlaps: {s['text_overlaps']}  |  broken media: {s['broken_media']}")
    print(f'Report: {report}')
    print(f'Metrics: {out / "metrics.json"}')

    if not args.deck and not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)

    return 0


if __name__ == '__main__':
    sys.exit(main())
