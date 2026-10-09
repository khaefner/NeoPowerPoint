#!/usr/bin/env python3
"""
validate_deck.py - sanity-check a NeoPowerPoint deck folder.

Usage: python3 validate_deck.py <deck-dir>
Exit code 0 = OK (warnings allowed), 1 = errors found.
"""
import json
import os
import re
import sys

ASPECTS = {'16:9', '4:3', '16:10', 'custom'}
TRANSITIONS = {'none', 'fade', 'slide-left', 'zoom'}


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    errors, warns = [], []
    mpath = os.path.join(root, 'deck.json')
    if not os.path.isfile(mpath):
        print('ERROR: deck.json not found in', root)
        return 1
    try:
        m = json.load(open(mpath, encoding='utf-8'))
    except Exception as e:
        print('ERROR: deck.json is not valid JSON:', e)
        return 1

    for k in ('version', 'title', 'aspectRatio', 'slides'):
        if k not in m:
            errors.append('deck.json missing required field "%s"' % k)
    if m.get('aspectRatio') not in ASPECTS:
        errors.append('aspectRatio must be one of %s' % sorted(ASPECTS))
    if not m.get('customWidth') or not m.get('customHeight'):
        warns.append('customWidth/customHeight not set (app falls back to 1920x1080 - wrong for 4:3 sources)')
    ids = set()
    for i, s in enumerate(m.get('slides', []), 1):
        tag = 'slide %d' % i
        for k in ('id', 'title', 'path'):
            if not s.get(k):
                errors.append('%s missing "%s"' % (tag, k))
        if s.get('id') in ids:
            errors.append('%s duplicate id %r' % (tag, s.get('id')))
        ids.add(s.get('id'))
        if s.get('transition') and s['transition'] not in TRANSITIONS:
            errors.append('%s invalid transition %r' % (tag, s['transition']))
        p = s.get('path', '')
        if '\\' in p or p.startswith('/') or '..' in p.split('/'):
            errors.append('%s path must be relative posix inside the deck: %r' % (tag, p))
            continue
        fp = os.path.join(root, p)
        if not os.path.isfile(fp):
            errors.append('%s file not found: %s' % (tag, p))
            continue
        html = open(fp, encoding='utf-8', errors='replace').read()
        if '<meta charset' not in html.lower():
            warns.append('%s (%s): missing <meta charset="UTF-8">' % (tag, p))
        if re.search(r'(src|href)\s*=\s*["\']https?://', html) or re.search(r'url\(\s*["\']?https?://', html):
            warns.append('%s (%s): remote http(s) resource - deck will not work offline; vendor it into assets/' % (tag, p))
        if re.search(r'(src|href)\s*=\s*["\'](file:|/[^/])', html):
            warns.append('%s (%s): absolute path reference; use relative paths like ../../assets/x' % (tag, p))
        for ref in re.findall(r'(?:src|href)\s*=\s*["\']([^"\'#?:]+)["\']', html):
            if ref.startswith(('data', 'mailto')):
                continue
            target = os.path.normpath(os.path.join(os.path.dirname(fp), ref))
            if not os.path.exists(target):
                errors.append('%s (%s): referenced file missing: %s' % (tag, p, ref))
    if not m.get('slides'):
        errors.append('deck has no slides')

    for w in warns:
        print('WARN :', w)
    for e in errors:
        print('ERROR:', e)
    print('%d slides, %d errors, %d warnings' % (len(m.get('slides', [])), len(errors), len(warns)))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
