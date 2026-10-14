#!/usr/bin/env python3
"""
extract_theme.py - Extracts active theme colors, font families, and layout structures
from a NeoPowerPoint presentation directory to inform AI slide generation.

Usage:
  python3 extract_theme.py /path/to/deck [current_slide_path]
"""
import sys
import os
import json
import re

def extract_theme(deck_path, current_slide_rel=None):
    manifest_path = os.path.join(deck_path, 'deck.json')
    if not os.path.exists(manifest_path):
        return {"error": "deck.json not found"}

    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
    except Exception as e:
        return {"error": f"Failed to read deck.json: {str(e)}"}

    width = manifest.get('customWidth', 1920)
    height = manifest.get('customHeight', 1080)
    aspect_ratio = manifest.get('aspectRatio', '16:9')
    deck_title = manifest.get('title', 'Presentation')
    theme_mode = manifest.get('theme', 'dark')

    # Read theme.css
    theme_css_path = os.path.join(deck_path, 'assets', 'theme.css')
    css_vars = {}
    font_families = set()
    bg_color = '#0f172a' if theme_mode == 'dark' else '#ffffff'
    text_color = '#f8fafc' if theme_mode == 'dark' else '#0f172a'
    accent_color = '#38bdf8'

    if os.path.exists(theme_css_path):
        with open(theme_css_path, 'r', encoding='utf-8', errors='ignore') as f:
            css_text = f.read()

        # Find variables: --var-name: value;
        for match in re.finditer(r'--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);', css_text):
            css_vars[match.group(1)] = match.group(2).strip()

        # Find fonts
        for match in re.finditer(r'font-family\s*:\s*([^;]+);', css_text):
            font_families.add(match.group(1).strip())

    # Read current or first slide HTML for specific motifs
    slide_sample_html = ""
    target_slide_path = None
    if current_slide_rel:
        full_candidate = os.path.join(deck_path, current_slide_rel)
        if os.path.exists(full_candidate):
            target_slide_path = full_candidate

    if not target_slide_path and manifest.get('slides'):
        first_slide_rel = manifest['slides'][0].get('path')
        if first_slide_rel:
            full_candidate = os.path.join(deck_path, first_slide_rel)
            if os.path.exists(full_candidate):
                target_slide_path = full_candidate

    if target_slide_path and os.path.exists(target_slide_path):
        with open(target_slide_path, 'r', encoding='utf-8', errors='ignore') as f:
            slide_sample_html = f.read()[:4000]

    return {
        "title": deck_title,
        "width": width,
        "height": height,
        "aspectRatio": aspect_ratio,
        "themeMode": theme_mode,
        "cssVariables": css_vars,
        "fontFamilies": list(font_families),
        "slideSampleHtml": slide_sample_html
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: extract_theme.py <deck-path> [current_slide_rel]"}))
        sys.exit(1)

    deck_dir = sys.argv[1]
    slide_rel = sys.argv[2] if len(sys.argv) > 2 else None
    result = extract_theme(deck_dir, slide_rel)
    print(json.dumps(result, indent=2))
