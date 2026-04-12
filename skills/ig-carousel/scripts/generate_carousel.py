#!/usr/bin/env python3
"""
IG Carousel Generator v5 — @freeeadman
Magazine-quality design with editorial photo backgrounds:
- Left-aligned layout, bold headlines, generous whitespace
- Warm color palette: 焦糖橘 accent, warm white text
- PingFang TC font family
- AI-generated atmospheric photo backgrounds

Usage:
  python3 generate_carousel.py --data carousel_data.json --output ./output/
"""

import json
import os
import sys
import argparse
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter
import glob

# --- Constants ---
WIDTH = 1080
HEIGHT = 1350
IG_HANDLE = "@freeeadman"
MARGIN = 90              # v5: wider margins for more whitespace
CONTENT_WIDTH = WIDTH - MARGIN * 2  # 900px
BOTTOM_BAR_H = 80
TOP_RESERVE = 100        # v5: more space for handle
CARD_PAD = 36            # v5: generous padding inside text cards
OPTICAL_CENTER_BIAS = 0.46

# --- Font Setup (PingFang TC) ---
FONT_PATH = "/System/Library/Fonts/PingFang.ttc"
FONT_IDX = {
    "semibold": 7,
    "regular": 1,
    "medium": 4,
    "light": 10,
}

FONT_SIZE_BOOST = 6  # 全局字體放大（老闆要求 +2 號，實際 px 加 6）
LINE_HEIGHT_BOOST = 8  # 行高同步放大，增加呼吸感

def get_font(size, weight="regular"):
    idx = FONT_IDX.get(weight, 1)
    try:
        return ImageFont.truetype(FONT_PATH, size + FONT_SIZE_BOOST, index=idx)
    except:
        return ImageFont.load_default()

# --- Color Themes ---
# v5: Unified brand palette — warm white text + 焦糖橘 accent
# Only one brand theme; accent_color from JSON can override
BRAND_THEME = {
    "name": "brand_caramel",
    "bg": "#2a2520",           # warm dark brown (fallback for solid bg)
    "text": "#F5F0EB",          # 米白 warm white
    "accent": "#D4874D",        # 焦糖橘
    "accent_dim": "#3d2a1a",
    "subtitle": "#B8B0A6",      # warm grey
    "tag_bg": "#D4874D",
    "tag_text": "#FFFDF8",
    "card_bg": "#352e28",       # warm dark card
    "highlight_bg": "#3d2a1a",
}

# Keep legacy list for backward compat but default to brand theme
THEMES = [BRAND_THEME]

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# --- Text Helpers ---
# 中文標點禁則：這些字元不可以出現在行首
NO_LINE_START = set("，。、！？；：）」』】》〉～…—─·,.!?;:)]}」』")
# 這些字元不可以出現在行尾
NO_LINE_END = set("（「『【《〈([{")

def wrap_text(draw, text, font, max_width):
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        chars = list(paragraph)
        current = ""
        i = 0
        while i < len(chars):
            char = chars[i]
            test = current + char
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > max_width:
                if not current:
                    # Single char exceeds width, force it
                    lines.append(char)
                    current = ""
                    i += 1
                    continue
                # Check: would next char (the one about to go to new line) be a no-start punct?
                if char in NO_LINE_START:
                    # Pull last char from current line to keep punct with it
                    if len(current) > 1:
                        pulled = current[-1]
                        lines.append(current[:-1])
                        current = pulled + char
                    else:
                        # current is only 1 char, just append both
                        current = test
                else:
                    # Check: would current line end with a no-end char?
                    if current and current[-1] in NO_LINE_END:
                        if len(current) > 1:
                            pulled = current[-1]
                            lines.append(current[:-1])
                            current = pulled + char
                        else:
                            current = test
                    else:
                        lines.append(current)
                        current = char
            else:
                current = test
            i += 1
        if current:
            lines.append(current)
    return lines

def draw_text_lines(draw, lines, font, x, y, color, line_height, accent_color=None):
    line_height += LINE_HEIGHT_BOOST
    """Draw pre-wrapped lines. Supports **accent** markers."""
    for line in lines:
        if accent_color and "**" in line:
            parts = line.split("**")
            cx = x
            for j, part in enumerate(parts):
                if not part:
                    continue
                c = accent_color if j % 2 == 1 else color
                draw.text((cx, y), part, fill=c, font=font)
                bbox = draw.textbbox((0, 0), part, font=font)
                cx += bbox[2] - bbox[0]
        else:
            draw.text((x, y), line, fill=color, font=font)
        y += line_height
    return y

def measure_block(draw, text, font, max_width, line_height):
    line_height += LINE_HEIGHT_BOOST
    """Return (lines, total_height)."""
    lines = wrap_text(draw, text, font, max_width)
    return lines, len(lines) * line_height

def vcenter_y(content_h):
    """Calculate Y start for vertically centered (optical) content."""
    usable = HEIGHT - TOP_RESERVE - BOTTOM_BAR_H
    offset = int(usable * OPTICAL_CENTER_BIAS) - content_h // 2
    y = TOP_RESERVE + max(offset, 20)
    return y

# --- Visual Components ---

def draw_pill_tag(draw, text, x, y, theme):
    font = get_font(22, "medium")
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    px, py = 18, 9
    w, h = tw + px * 2, th + py * 2
    draw.rounded_rectangle([(x, y), (x + w, y + h)], radius=h // 2, fill=hex_to_rgb(theme["tag_bg"]))
    draw.text((x + px, y + py - 2), text, fill=hex_to_rgb(theme["tag_text"]), font=font)
    return w, h

def draw_stat_card(draw, img, number, label, x, y, w, h, theme):
    """Draw a stat card with big number + label."""
    card_bg = hex_to_rgb(theme["card_bg"])
    accent = hex_to_rgb(theme["accent"])
    text_col = hex_to_rgb(theme["text"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    # Card background
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle([(x, y), (x + w, y + h)], radius=16, fill=(*card_bg, 255))
    # Accent top border
    od.rounded_rectangle([(x, y), (x + w, y + 4)], radius=2, fill=(*accent, 255))
    img_rgba = img.convert("RGBA")
    img = Image.alpha_composite(img_rgba, overlay).convert("RGB")
    draw_new = ImageDraw.Draw(img)
    
    # Number
    num_font = get_font(54, "semibold")
    num_bbox = draw_new.textbbox((0, 0), number, font=num_font)
    num_w = num_bbox[2] - num_bbox[0]
    draw_new.text((x + (w - num_w) // 2, y + 26), number, fill=accent, font=num_font)
    
    # Label
    lbl_font = get_font(24, "light")
    lbl_bbox = draw_new.textbbox((0, 0), label, font=lbl_font)
    lbl_w = lbl_bbox[2] - lbl_bbox[0]
    draw_new.text((x + (w - lbl_w) // 2, y + 92), label, fill=sub_col, font=lbl_font)
    
    return img

def draw_highlight_box(draw, img, text, x, y, w, theme, font=None, pad=20):
    """Draw a rounded highlight box with left accent border."""
    if font is None:
        font = get_font(30, "regular")
    
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    highlight_bg = hex_to_rgb(theme["highlight_bg"])
    
    lines = wrap_text(draw, text, font, w - pad * 2 - 12)
    line_h = 48
    h = len(lines) * line_h + pad * 2
    
    # Background
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle([(x, y), (x + w, y + h)], radius=12, fill=(*highlight_bg, 255))
    # Left accent bar
    od.rounded_rectangle([(x, y + 6), (x + 4, y + h - 6)], radius=2, fill=(*accent, 255))
    img_rgba = img.convert("RGBA")
    img = Image.alpha_composite(img_rgba, overlay).convert("RGB")
    draw_new = ImageDraw.Draw(img)
    
    # Text
    ty = y + pad
    for line in lines:
        draw_new.text((x + pad + 8, ty), line, fill=text_col, font=font)
        ty += line_h
    
    return img, h

def draw_divider(draw, y, theme, style="line"):
    """Draw a subtle divider."""
    sub = hex_to_rgb(theme["subtitle"])
    accent = hex_to_rgb(theme["accent"])
    if style == "line":
        draw.line([(MARGIN, y), (WIDTH - MARGIN, y)], fill=(*sub, 40), width=1)
    elif style == "dots":
        for i in range(3):
            cx = WIDTH // 2 - 16 + i * 16
            draw.ellipse([(cx - 2, y - 2), (cx + 2, y + 2)], fill=(*sub, 80))
    elif style == "accent":
        draw.rounded_rectangle([(MARGIN, y), (MARGIN + 40, y + 3)], radius=2, fill=accent)

# --- UI Elements ---
def draw_ui(draw, slide_num, total_slides, theme, is_last=False):
    sub_col = hex_to_rgb(theme["subtitle"])
    accent = hex_to_rgb(theme["accent"])
    
    handle_font = get_font(22, "light")
    draw.text((MARGIN, 44), IG_HANDLE, fill=sub_col, font=handle_font)
    
    bar_y = HEIGHT - BOTTOM_BAR_H
    ui_font = get_font(17, "light")
    draw.text((MARGIN, bar_y + 30), "↗ SHARE", fill=sub_col, font=ui_font)
    save_text = "☆ SAVE"
    save_bbox = draw.textbbox((0, 0), save_text, font=ui_font)
    draw.text((WIDTH - MARGIN - (save_bbox[2] - save_bbox[0]), bar_y + 30), save_text, fill=sub_col, font=ui_font)
    
    dot_r, dot_sp = 4, 16
    total_w = (total_slides - 1) * dot_sp
    sx = (WIDTH - total_w) // 2
    dy = bar_y + 12
    for i in range(total_slides):
        cx = sx + i * dot_sp
        if i + 1 == slide_num:
            draw.ellipse([(cx - dot_r - 1, dy - dot_r - 1), (cx + dot_r + 1, dy + dot_r + 1)], fill=accent)
        else:
            draw.ellipse([(cx - dot_r, dy - dot_r), (cx + dot_r, dy + dot_r)], fill=(*sub_col, 80))
    
    page_font = get_font(15, "light")
    pt = f"{slide_num}/{total_slides}"
    pb = draw.textbbox((0, 0), pt, font=page_font)
    draw.text(((WIDTH - (pb[2] - pb[0])) // 2, dy + 15), pt, fill=sub_col, font=page_font)
    
    if not is_last:
        af = get_font(26, "light")
        draw.text((WIDTH - 48, HEIGHT // 2 - 13), "〉", fill=(*sub_col, 70), font=af)

# --- Slide Renderers ---

def render_cover(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    tag = slide.get("tag", "")
    headline = slide.get("headline", "")
    subtitle = slide.get("subtitle", "")
    
    h_font = get_font(62, "semibold")
    s_font = get_font(32, "light")
    h_lh, s_lh = 78, 46
    
    h_lines, h_h = measure_block(draw, headline, h_font, CONTENT_WIDTH - 20, h_lh)
    s_lines, s_h = ([], 0) if not subtitle else measure_block(draw, subtitle, s_font, CONTENT_WIDTH, s_lh)
    
    tag_h = 50 if tag else 0
    total_h = tag_h + h_h + (24 + s_h if subtitle else 0)
    
    
    y = vcenter_y(total_h)
    
    if tag:
        draw_pill_tag(draw, tag, MARGIN, y, theme)
        y += tag_h
    
    y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, text_col, h_lh, accent)
    
    if subtitle:
        y += 24
        draw_text_lines(draw, s_lines, s_font, MARGIN, y, sub_col, s_lh)
    
    return img

def draw_text_card_bg(draw, img, x, y, w, h, theme, opacity=120):
    """Draw a semi-transparent dark card background for text readability on photo backgrounds."""
    card_bg = hex_to_rgb(theme.get("card_bg", "#252525"))
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle([(x, y), (x + w, y + h)], radius=18, fill=(*card_bg, opacity))
    img_rgba = img.convert("RGBA")
    img = Image.alpha_composite(img_rgba, overlay).convert("RGB")
    return img

def render_body(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    headline = slide.get("headline", "")
    body = slide.get("body", "")
    highlights = slide.get("highlights", [])  # list of highlight box texts
    stats = slide.get("stats", [])  # list of {"number": "1.8x", "label": "互動率"}
    
    h_font = get_font(48, "semibold")
    b_font = get_font(32, "regular")
    h_lh, b_lh = 64, 48
    
    # --- Measure total content (use narrower width to prevent edge overflow) ---
    text_max_w = CONTENT_WIDTH - 20  # safety margin for text wrapping
    h_lines, h_h = measure_block(draw, headline, h_font, text_max_w, h_lh) if headline else ([], 0)
    b_lines, b_h = measure_block(draw, body, b_font, text_max_w, b_lh) if body else ([], 0)
    
    content_h = h_h
    if h_h and (b_h or highlights or stats):
        content_h += 24
    if stats:
        content_h += 120
        if b_h or highlights:
            content_h += 20
    if b_h:
        content_h += b_h
        if highlights:
            content_h += 20
    for hl in highlights:
        hl_lines = wrap_text(draw, hl, get_font(28, "regular"), CONTENT_WIDTH - 56)
        content_h += len(hl_lines) * 40 + 40 + 16
    
    
    y = vcenter_y(content_h)
    
    # --- Draw semi-transparent card behind all content for photo bg readability ---
    card_pad = CARD_PAD
    card_top = y - card_pad
    card_bot = y + content_h + card_pad
    card_x = MARGIN - card_pad
    card_w = CONTENT_WIDTH + card_pad * 2
    img = draw_text_card_bg(draw, img, card_x, card_top, card_w, card_bot - card_top, theme, opacity=130)
    draw = ImageDraw.Draw(img)
    
    # --- Render ---
    if h_lines:
        y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, text_col, h_lh, accent)
        y += 24
    
    # Stat cards
    if stats:
        num_stats = len(stats)
        card_w = min(220, (CONTENT_WIDTH - 20 * (num_stats - 1)) // num_stats)
        card_h = 140
        total_cards_w = card_w * num_stats + 20 * (num_stats - 1)
        sx = MARGIN + (CONTENT_WIDTH - total_cards_w) // 2
        for si, st in enumerate(stats):
            cx = sx + si * (card_w + 20)
            img = draw_stat_card(draw, img, st["number"], st["label"], cx, y, card_w, card_h, theme)
            draw = ImageDraw.Draw(img)
        y += card_h + 20
    
    # Body text
    if b_lines:
        y = draw_text_lines(draw, b_lines, b_font, MARGIN, y, text_col, b_lh, accent)
        y += 20
    
    # Highlight boxes
    for hl in highlights:
        hl_font = get_font(28, "regular")
        img, box_h = draw_highlight_box(draw, img, hl, MARGIN, y, CONTENT_WIDTH, theme, hl_font, pad=18)
        draw = ImageDraw.Draw(img)
        y += box_h + 16
    
    return img

def render_steps(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    card_bg = hex_to_rgb(theme["card_bg"])
    
    headline = slide.get("headline", "")
    items = slide.get("items", [])
    
    h_font = get_font(44, "semibold")
    h_lh = 58
    
    # Size items — reduce font for readability in cards
    num_items = len(items)
    if num_items <= 3:
        i_size, i_lh = 27, 40
    elif num_items <= 5:
        i_size, i_lh = 25, 36
    else:
        i_size, i_lh = 22, 32
    
    item_font = get_font(i_size, "regular")
    num_font = get_font(24, "semibold")
    badge_offset = 56          # space for number badge from MARGIN
    text_x = MARGIN + badge_offset  # where text starts
    text_pad_right = 32        # padding from card right edge
    card_pad_v = 24            # vertical padding inside cards
    card_gap = 18              # gap between cards
    
    # Effective text width: from text_x to (WIDTH - MARGIN - text_pad_right)
    effective_text_w = (WIDTH - MARGIN - text_pad_right) - text_x
    
    # Measure
    h_lines, h_h = measure_block(draw, headline, h_font, CONTENT_WIDTH - 20, h_lh) if headline else ([], 0)
    
    item_data = []
    total_items_h = 0
    for item in items:
        lines = wrap_text(draw, item, item_font, effective_text_w)
        ch = max(len(lines), 1) * i_lh + card_pad_v * 2
        ch = max(ch, 64)
        item_data.append((lines, ch))
        total_items_h += ch + card_gap
    total_items_h -= card_gap  # remove last gap
    
    content_h = h_h + 28 + total_items_h
    
    y = vcenter_y(content_h)
    
    # Headline
    if h_lines:
        y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, accent, h_lh)
        y += 28
    
    # Items as cards
    for i, (lines, ch) in enumerate(item_data):
        # Card bg
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle([(MARGIN, y), (WIDTH - MARGIN, y + ch)], radius=14, fill=(*card_bg, 255))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)
        
        # Number
        n = str(i + 1)
        nb = draw.textbbox((0, 0), n, font=num_font)
        nw, nh = nb[2] - nb[0], nb[3] - nb[1]
        badge_x, badge_y = MARGIN + 28, y + ch // 2
        badge_r = 18
        draw.ellipse([(badge_x - badge_r, badge_y - badge_r), (badge_x + badge_r, badge_y + badge_r)], fill=accent)
        draw.text((badge_x - nw // 2, badge_y - nh // 2 - 2), n, fill="#ffffff", font=num_font)
        
        # Text — all lines aligned to same x position
        ty = y + (ch - len(lines) * i_lh) // 2
        for line in lines:
            draw.text((text_x, ty), line, fill=text_col, font=item_font)
            ty += i_lh
        
        y += ch + card_gap
    
    return img

def render_comparison(draw, img, slide, theme):
    """Comparison: two columns (before/after, A vs B)."""
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    card_bg = hex_to_rgb(theme["card_bg"])
    
    headline = slide.get("headline", "")
    left_title = slide.get("left_title", "Before")
    right_title = slide.get("right_title", "After")
    left_items = slide.get("left_items", [])
    right_items = slide.get("right_items", [])
    
    h_font = get_font(40, "semibold")
    t_font = get_font(26, "semibold")
    i_font = get_font(24, "regular")
    h_lh, i_lh = 52, 36
    
    h_lines, h_h = measure_block(draw, headline, h_font, CONTENT_WIDTH, h_lh) if headline else ([], 0)
    
    col_w = (CONTENT_WIDTH - 20) // 2
    max_rows = max(len(left_items), len(right_items))
    col_h = 50 + max_rows * i_lh + 30  # title + items + padding
    
    content_h = h_h + 24 + col_h
    
    y = vcenter_y(content_h)
    
    if h_lines:
        y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, text_col, h_lh, accent)
        y += 24
    
    # Left column card
    lx = MARGIN
    rx = MARGIN + col_w + 20
    for cx, title, items, is_accent in [(lx, left_title, left_items, False), (rx, right_title, right_items, True)]:
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle([(cx, y), (cx + col_w, y + col_h)], radius=14, fill=(*card_bg, 255))
        if is_accent:
            od.rounded_rectangle([(cx, y), (cx + col_w, y + 4)], radius=2, fill=(*accent, 255))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)
        
        # Title
        tc = accent if is_accent else sub_col
        draw.text((cx + 16, y + 16), title, fill=tc, font=t_font)
        
        # Items
        iy = y + 54
        for item in items:
            prefix = "✓ " if is_accent else "✗ "
            pc = accent if is_accent else sub_col
            draw.text((cx + 16, iy), prefix, fill=pc, font=i_font)
            draw.text((cx + 42, iy), item, fill=text_col, font=i_font)
            iy += i_lh
    
    return img

def render_quote(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    quote = slide.get("body", slide.get("headline", ""))
    source = slide.get("source", "")
    
    q_font = get_font(42, "semibold")
    s_font = get_font(22, "light")
    q_lh = 56
    
    q_lines, q_h = measure_block(draw, quote, q_font, CONTENT_WIDTH - 40, q_lh)
    content_h = 80 + q_h + (40 if source else 0)
    
    y = vcenter_y(content_h)
    
    # Semi-transparent card
    card_pad = CARD_PAD
    card_x = MARGIN - card_pad
    card_w = CONTENT_WIDTH + card_pad * 2
    img = draw_text_card_bg(draw, img, card_x, y - card_pad, card_w, content_h + card_pad * 2, theme, opacity=130)
    draw = ImageDraw.Draw(img)
    
    # Quote mark
    qm_font = get_font(140, "semibold")
    draw.text((MARGIN - 6, y - 30), "「", fill=(*accent, 40), font=qm_font)
    y += 80
    
    y = draw_text_lines(draw, q_lines, q_font, MARGIN + 8, y, text_col, q_lh)
    
    if source:
        y += 24
        draw.text((MARGIN + 8, y), f"— {source}", fill=sub_col, font=s_font)
    
    return img

def render_cta(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    headline = slide.get("headline", "")
    body = slide.get("body", "")
    button_text = slide.get("button_text", "💬 留言分享你的想法")
    
    h_font = get_font(44, "semibold")
    b_font = get_font(28, "light")
    btn_font = get_font(24, "medium")
    h_lh, b_lh = 58, 40
    
    text_max_w = CONTENT_WIDTH - 20
    h_lines, h_h = measure_block(draw, headline, h_font, text_max_w, h_lh)
    b_lines, b_h = measure_block(draw, body, b_font, text_max_w, b_lh) if body else ([], 0)
    
    content_h = h_h + (24 + b_h if body else 0) + 80
    
    y = vcenter_y(content_h)
    
    # Semi-transparent card behind CTA content
    card_pad = CARD_PAD
    card_x = MARGIN - card_pad
    card_w = CONTENT_WIDTH + card_pad * 2
    img = draw_text_card_bg(draw, img, card_x, y - card_pad - 20, card_w, content_h + card_pad * 2 + 20, theme, opacity=130)
    draw = ImageDraw.Draw(img)
    
    # Accent line above headline
    draw_divider(draw, y - 20, theme, "accent")
    
    y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, text_col, h_lh, accent)
    
    if b_lines:
        y += 16
        y = draw_text_lines(draw, b_lines, b_font, MARGIN, y, sub_col, b_lh)
    
    y += 36
    bb = draw.textbbox((0, 0), button_text, font=btn_font)
    bw, bh_t = bb[2] - bb[0], bb[3] - bb[1]
    btn_h = 52
    box_w = bw + 48
    box_x = (WIDTH - box_w) // 2
    draw.rounded_rectangle([(box_x, y), (box_x + box_w, y + btn_h)], radius=btn_h // 2, fill=hex_to_rgb(theme["accent"]))
    draw.text(((WIDTH - bw) // 2, y + (btn_h - bh_t) // 2 - 2), button_text, fill=hex_to_rgb(theme.get("tag_text", "#ffffff")), font=btn_font)
    
    return img

def render_keypoint(draw, img, slide, theme):
    text_col = hex_to_rgb(theme["text"])
    accent = hex_to_rgb(theme["accent"])
    sub_col = hex_to_rgb(theme["subtitle"])
    
    headline = slide.get("headline", "")
    body = slide.get("body", "")
    number = slide.get("number", "")
    
    h_font = get_font(40, "semibold")
    b_font = get_font(28, "regular")
    h_lh, b_lh = 54, 42
    
    text_max_w = CONTENT_WIDTH - 20
    h_lines, h_h = measure_block(draw, headline, h_font, text_max_w, h_lh) if headline else ([], 0)
    b_lines, b_h = measure_block(draw, body, b_font, text_max_w, b_lh) if body else ([], 0)
    
    num_h = 130 if number else 0
    content_h = num_h + h_h + 20 + b_h
    
    y = vcenter_y(content_h)
    
    # Semi-transparent card
    card_pad = CARD_PAD
    card_x = MARGIN - card_pad
    card_w = CONTENT_WIDTH + card_pad * 2
    img = draw_text_card_bg(draw, img, card_x, y - card_pad, card_w, content_h + card_pad * 2, theme, opacity=130)
    draw = ImageDraw.Draw(img)
    
    if number:
        nf = get_font(100, "semibold")
        draw.text((MARGIN, y), str(number), fill=accent, font=nf)
        y += num_h
    
    if h_lines:
        y = draw_text_lines(draw, h_lines, h_font, MARGIN, y, text_col, h_lh)
        y += 16
        draw_divider(draw, y, theme, "accent")
        y += 20
    
    if b_lines:
        draw_text_lines(draw, b_lines, b_font, MARGIN, y, sub_col, b_lh)
    
    return img


RENDERERS = {
    "cover": render_cover,
    "body": render_body,
    "content": render_body,
    "problem": render_body,
    "solution": render_body,
    "detail": render_body,
    "summary": render_body,
    "highlight": render_quote,  # highlight = large quote/key sentence
    "steps": render_steps,
    "comparison": render_comparison,
    "cta": render_cta,
    "quote": render_quote,
    "keypoint": render_keypoint,
}

# --- Background Helpers ---
BG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "backgrounds")

def load_photo_bg(bg_path=None, darken=0.35):
    """Load a photo, resize to fill 1080x1350, darken it.
    bg_path can be a specific AI-generated background or fallback to assets/backgrounds/.
    """
    if bg_path and os.path.exists(bg_path):
        img = Image.open(bg_path).convert("RGB")
    else:
        # Fallback: pick random from assets/backgrounds/
        bgs = glob.glob(os.path.join(BG_DIR, "*.png")) + glob.glob(os.path.join(BG_DIR, "*.jpg"))
        if not bgs:
            return None
        img = Image.open(random.choice(bgs)).convert("RGB")
    
    # Resize to cover 1080x1350
    iw, ih = img.size
    scale = max(WIDTH / iw, HEIGHT / ih)
    new_w, new_h = int(iw * scale), int(ih * scale)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    
    # Center crop
    left = (new_w - WIDTH) // 2
    top = (new_h - HEIGHT) // 2
    img = img.crop((left, top, left + WIDTH, top + HEIGHT))
    
    # Darken with semi-transparent overlay
    # darken value = how dark (0.0 = no darkening, 1.0 = full black)
    # Default 0.65 means 65% black overlay → keeps 35% of original brightness
    overlay = Image.new("RGBA", img.size, (0, 0, 0, int(darken * 255)))
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    
    # Slight blur for text readability
    img = img.filter(ImageFilter.GaussianBlur(radius=2.0))
    
    return img

# --- Main ---
def generate_carousel(data, output_dir):
    slides = data["slides"]
    total = len(slides)
    
    # v5: Default to brand theme, allow JSON override
    theme = dict(BRAND_THEME)  # always start from brand theme
    
    if "theme" in data and isinstance(data["theme"], dict):
        theme.update(data["theme"])
    
    # Allow accent_color override from JSON
    if "accent_color" in data:
        ac = data["accent_color"]
        theme["accent"] = ac
        theme["tag_bg"] = ac
    
    # Check for photo background mode
    bg_mode = data.get("bg_mode", "photo")  # v5: default to photo
    bg_photo_path = data.get("bg_photo", None)
    bg_darken = data.get("bg_darken", 0.45)  # v5: lighter default (was 0.35)
    
    bg = hex_to_rgb(theme["bg"])
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    
    # Pre-load photo backgrounds
    # Priority: AI-generated backgrounds (bg_slide{n}.png) > specific path > assets/backgrounds/
    photo_bgs = []
    if bg_mode == "photo":
        bg_per_slide = data.get("bg_per_slide", False)
        ai_bg_dir = os.path.join(output_dir, "backgrounds")
        
        if bg_per_slide:
            for si in range(len(slides)):
                # Check for AI-generated background first
                ai_bg_path = os.path.join(ai_bg_dir, f"bg_slide{si+1}.png")
                if os.path.exists(ai_bg_path):
                    photo_bgs.append(load_photo_bg(ai_bg_path, bg_darken))
                else:
                    photo_bgs.append(load_photo_bg(None, bg_darken))
        else:
            shared_bg = load_photo_bg(bg_photo_path, bg_darken)
            photo_bgs = [shared_bg] * total
    
    generated = []
    for i, slide in enumerate(slides, 1):
        if bg_mode == "photo" and photo_bgs[i-1]:
            img = photo_bgs[i-1].copy()
        else:
            img = Image.new("RGB", (WIDTH, HEIGHT), bg)
        draw = ImageDraw.Draw(img)
        
        stype = slide.get("type", "body")
        renderer = RENDERERS.get(stype, RENDERERS["body"])
        result = renderer(draw, img, slide, theme)
        if result is not None:
            img = result
            draw = ImageDraw.Draw(img)
        
        draw_ui(draw, i, total, theme, is_last=(i == total))
        
        cid = data.get("id", "carousel")
        fname = f"{cid}_slide{i}.png"
        fp = out / fname
        img.save(fp, "PNG", quality=95)
        generated.append(str(fp))
        print(f"  ✅ Generated: {fname}")
    
    return generated

def main():
    parser = argparse.ArgumentParser(description="IG Carousel Generator v4")
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    
    with open(args.data, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    files = generate_carousel(data, args.output)
    print(f"\n🎨 Generated {len(files)} slides → {args.output}")

if __name__ == "__main__":
    main()
