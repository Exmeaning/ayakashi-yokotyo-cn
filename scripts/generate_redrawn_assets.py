# -*- coding: utf-8 -*-
"""
Redraw images containing embedded Japanese text into Chinese:
1. assets/webp/common/logo_ayakashi-yokotyo.webp (1152x510)
2. assets/webp/index/btn_start.webp (1032x246)
3. assets/webp/index/bnr_share.webp (1032x438)
4. assets/webp/common/ttl_endinglist.webp (1096x270)
5. assets/webp/clear/ttl_clear.webp (1152x345)
6. assets/webp/clear/txt_clear.webp (1092x195)
7. assets/webp/clear/btn_post.webp (1032x246)
8. assets/webp/ogp/ogp.webp (1200x630)
"""

import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIRROR = os.path.join(ROOT, 'mirror')
DIST = os.path.join(ROOT, 'dist')

FONT_YAHEI_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_YUANTI = 'C:/Windows/Fonts/FZYTK.TTF' if os.path.exists('C:/Windows/Fonts/FZYTK.TTF') else FONT_YAHEI_BOLD
FONT_SIMHEI = 'C:/Windows/Fonts/simhei.ttf'
FONT_SERIF = 'C:/Windows/Fonts/simsunb.ttf'

def get_font(font_path, size):
    try:
        return ImageFont.truetype(font_path, size)
    except Exception:
        return ImageFont.truetype(FONT_YAHEI_BOLD, size)

def clean_button_background(orig_img):
    """
    Cleans the center text from btn_start / btn_post while preserving
    the exact red checkered background and edge pill frame with sparkle decorations.
    """
    w, h = orig_img.size
    img = orig_img.copy().convert('RGBA')
    # The checkered pattern repeats every 38 pixels approximately.
    # We can sample the clean checkered pattern from the left/right parts of the button
    # and tile it over the center area (x from 160 to w - 160, y from 40 to h - 40).
    # Or create a seamless patch from the left inner area.
    
    # Left inner patch
    patch_w = 120
    patch_h = h - 60
    patch = img.crop((60, 30, 60 + patch_w, 30 + patch_h))
    
    # Inpaint center by blending patches
    center_x1 = 150
    center_x2 = w - 150
    
    # Better: clone clean columns from left/right
    for x in range(center_x1, center_x2, patch_w):
        img.paste(patch, (x, 30))
    # Crop the exact right seam if needed
    img.paste(img.crop((w - 180, 0, w, h)), (w - 180, 0))
    img.paste(img.crop((0, 0, 180, h)), (0, 0))
    return img

def render_text_with_outline(draw, pos, text, font, fill_color, outline_color, outline_width=6):
    x, y = pos
    # Draw outline
    for dx in range(-outline_width, outline_width + 1):
        for dy in range(-outline_width, outline_width + 1):
            if dx * dx + dy * dy <= outline_width * outline_width:
                draw.text((x + dx, y + dy), text, font=font, fill=outline_color)
    # Draw fill
    draw.text((x, y), text, font=font, fill=fill_color)

def redraw_btn_start():
    orig_path = os.path.join(MIRROR, 'assets/webp/index/btn_start.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    # Create clean background
    bg = clean_button_background(orig)
    
    # Create text layer
    txt_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_layer)
    
    text = "开始游戏！"
    font = get_font(FONT_YUANTI, 108)
    
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    
    tx = (w - tw) // 2 - bbox[0]
    ty = (h - th) // 2 - bbox[1] - 4
    
    # Draw subtle shadow
    draw.text((tx, ty + 4), text, font=font, fill=(180, 20, 40, 120))
    # Draw main text in crisp white
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
    
    result = Image.alpha_composite(bg, txt_layer)
    return result

def redraw_btn_post():
    orig_path = os.path.join(MIRROR, 'assets/webp/clear/btn_post.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    bg = clean_button_background(orig)
    
    # Preserve original 𝕏 logo from left side
    x_logo_crop = orig.crop((120, 50, 220, 190))
    
    txt_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_layer)
    
    text = "发布结果！"
    font = get_font(FONT_YUANTI, 100)
    
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    
    # Offset slightly to the right of X logo
    tx = 240 + (w - 280 - tw) // 2 - bbox[0]
    ty = (h - th) // 2 - bbox[1] - 4
    
    draw.text((tx, ty + 4), text, font=font, fill=(180, 20, 40, 120))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
    
    result = Image.alpha_composite(bg, txt_layer)
    # Paste back original crisp X logo
    result.paste(x_logo_crop, (120, 50), x_logo_crop)
    return result

def redraw_bnr_share():
    orig_path = os.path.join(MIRROR, 'assets/webp/index/bnr_share.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    # Copy original left part (X button & card frame)
    # Clean the right text area (x: 350 to w-40, y: 40 to h-40) with matching card background
    bg = orig.copy()
    
    # Sample clean card texture from (40, 40, 140, h-40)
    card_sample = orig.crop((40, 40, 140, h - 40))
    for x in range(350, w - 50, 80):
        bg.paste(card_sample.crop((0, 0, min(80, w - 50 - x), h - 80)), (x, 40))
    
    # Re-paste border details on the right
    bg.paste(orig.crop((w - 60, 0, w, h)), (w - 60, 0))
    
    txt_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_layer)
    
    # Top line: 分享
    font_top = get_font(FONT_YAHEI_BOLD, 70)
    # Bottom line: 本网站！
    font_bot = get_font(FONT_YUANTI, 100)
    
    text_top = "分享"
    text_bot = "本网站！"
    
    # Position
    base_x = 420
    draw.text((base_x + 60, 65), text_top, font=font_top, fill=(90, 24, 32, 255))
    
    # Bottom line with gold/orange fill and deep red outline
    render_text_with_outline(draw, (base_x, 180), text_bot, font_bot, 
                             fill_color=(254, 218, 106, 255), 
                             outline_color=(120, 28, 36, 255), 
                             outline_width=8)
    
    # Draw star sparkles
    star_color = (250, 180, 50, 255)
    # Small decorative diamonds
    def draw_star(cx, cy, r):
        pts = [(cx, cy - r), (cx + r * 0.3, cy - r * 0.3), (cx + r, cy), 
               (cx + r * 0.3, cy + r * 0.3), (cx, cy + r), (cx - r * 0.3, cy + r * 0.3),
               (cx - r, cy), (cx - r * 0.3, cy - r * 0.3)]
        draw.polygon(pts, fill=star_color)
    
    draw_star(base_x + 480, 85, 20)
    draw_star(base_x + 530, 160, 12)
    
    result = Image.alpha_composite(bg, txt_layer)
    return result

def redraw_ttl_endinglist():
    orig_path = os.path.join(MIRROR, 'assets/webp/common/ttl_endinglist.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Top text: Ending list
    font_top = get_font(FONT_SERIF, 44)
    top_text = "Ending list"
    bbox_top = draw.textbbox((0, 0), top_text, font=font_top)
    top_w = bbox_top[2] - bbox_top[0]
    draw.text(((w - top_w) // 2, 10), top_text, font=font_top, fill=(128, 24, 36, 255))
    
    # Main text: 结局一览
    font_main = get_font(FONT_YUANTI, 120)
    main_text = "结局一览"
    
    bbox_main = draw.textbbox((0, 0), main_text, font=font_main)
    mw = bbox_main[2] - bbox_main[0]
    mh = bbox_main[3] - bbox_main[1]
    
    mx = (w - mw) // 2 - bbox_main[0]
    my = 95 - bbox_main[1]
    
    # Outline in deep navy
    render_text_with_outline(draw, (mx, my), main_text, font_main,
                             fill_color=(255, 198, 70, 255),
                             outline_color=(24, 46, 78, 255),
                             outline_width=10)
    
    # Inner gradient / highlight
    # Draw stars on left and right
    def draw_star(cx, cy, r, color=(255, 198, 70, 255)):
        pts = [(cx, cy - r), (cx + r * 0.35, cy - r * 0.35), (cx + r, cy), 
               (cx + r * 0.35, cy + r * 0.35), (cx, cy + r), (cx - r * 0.35, cy + r * 0.35),
               (cx - r, cy), (cx - r * 0.35, cy - r * 0.35)]
        draw.polygon(pts, fill=color)
        draw.line([(cx, cy - r), (cx, cy + r)], fill=(255, 255, 255, 200), width=2)
        draw.line([(cx - r, cy), (cx + r, cy)], fill=(255, 255, 255, 200), width=2)
    
    draw_star(100, 160, 24)
    draw_star(120, 220, 14)
    draw_star(w - 100, 160, 24)
    draw_star(w - 120, 220, 14)
    draw_star(w - 135, 100, 18)
    
    return img

def redraw_ttl_clear():
    orig_path = os.path.join(MIRROR, 'assets/webp/clear/ttl_clear.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Top text: Congratulations
    font_top = get_font(FONT_SERIF, 48)
    top_text = "Congratulations"
    bbox_top = draw.textbbox((0, 0), top_text, font=font_top)
    top_w = bbox_top[2] - bbox_top[0]
    draw.text(((w - top_w) // 2, 10), top_text, font=font_top, fill=(128, 24, 36, 255))
    
    # Main text: 妖怪事件解决！
    font_main = get_font(FONT_YUANTI, 110)
    main_text = "妖怪事件解决！"
    
    bbox_main = draw.textbbox((0, 0), main_text, font=font_main)
    mw = bbox_main[2] - bbox_main[0]
    mh = bbox_main[3] - bbox_main[1]
    
    mx = (w - mw) // 2 - bbox_main[0]
    my = 125 - bbox_main[1]
    
    # Outline in navy, fill in warm coral/red
    render_text_with_outline(draw, (mx, my), main_text, font_main,
                             fill_color=(245, 95, 100, 255),
                             outline_color=(24, 46, 78, 255),
                             outline_width=10)
    
    # Draw stars
    def draw_star(cx, cy, r, color=(255, 198, 70, 255)):
        pts = [(cx, cy - r), (cx + r * 0.35, cy - r * 0.35), (cx + r, cy), 
               (cx + r * 0.35, cy + r * 0.35), (cx, cy + r), (cx - r * 0.35, cy + r * 0.35),
               (cx - r, cy), (cx - r * 0.35, cy - r * 0.35)]
        draw.polygon(pts, fill=color)
    
    draw_star(80, 260, 20)
    draw_star(140, 310, 14)
    draw_star(w - 140, 100, 22)
    draw_star(w - 70, 180, 16)
    
    return img

def redraw_txt_clear():
    orig_path = os.path.join(MIRROR, 'assets/webp/clear/txt_clear.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    
    # Glow layer
    glow_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    
    font_top = get_font(FONT_YAHEI_BOLD, 62)
    font_bot = get_font(FONT_YAHEI_BOLD, 54)
    
    text_top = "解决妖怪事件"
    text_bot = "\\ 解锁各种各样的结局吧！ /"
    
    bbox_top = glow_draw.textbbox((0, 0), text_top, font=font_top)
    top_w = bbox_top[2] - bbox_top[0]
    tx = (w - top_w) // 2 - bbox_top[0]
    ty = 15 - bbox_top[1]
    
    bbox_bot = glow_draw.textbbox((0, 0), text_bot, font=font_bot)
    bot_w = bbox_bot[2] - bbox_bot[0]
    bx = (w - bot_w) // 2 - bbox_bot[0]
    by = 100 - bbox_bot[1]
    
    # Draw cyan glow
    glow_color = (120, 235, 245, 220)
    for rad in range(12, 0, -2):
        glow_draw.text((tx, ty), text_top, font=font_top, fill=glow_color)
        glow_draw.text((bx, by), text_bot, font=font_bot, fill=glow_color)
    
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(8))
    
    # Main text layer
    txt_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(txt_layer)
    
    draw.text((tx, ty), text_top, font=font_top, fill=(255, 255, 255, 255))
    draw.text((bx, by), text_bot, font=font_bot, fill=(254, 218, 90, 255))
    
    result = Image.alpha_composite(glow_layer, txt_layer)
    return result

def redraw_logo():
    orig_path = os.path.join(MIRROR, 'assets/webp/common/logo_ayakashi-yokotyo.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Preserve fireworks & sparkles background from original
    # We can mask out the original Japanese letters while keeping the fireworks and background sparkles!
    # Let's inspect original alpha and create clean background
    bg_decor = orig.copy()
    # Mask out the text area
    mask = Image.new('L', (w, h), 255)
    mask_draw = ImageDraw.Draw(mask)
    # Cut out text bounding boxes
    mask_draw.rectangle([50, 70, w - 50, h - 30], fill=0)
    # Smooth edges of mask
    mask = mask.filter(ImageFilter.GaussianBlur(10))
    bg_decor.putalpha(ImageOps.invert(mask).point(lambda p: 0 if p > 50 else 255))
    
    # Top: Project SEKAI
    font_top = get_font(FONT_SERIF, 44)
    top_text = "Project SEKAI"
    bbox_top = draw.textbbox((0, 0), top_text, font=font_top)
    top_w = bbox_top[2] - bbox_top[0]
    draw.text(((w - top_w) // 2, 20), top_text, font=font_top, fill=(128, 24, 36, 255))
    
    # Line 1: 妖怪小巷的
    font_line1 = get_font(FONT_YUANTI, 130)
    text_line1 = "妖怪小巷的"
    bbox1 = draw.textbbox((0, 0), text_line1, font=font_line1)
    w1 = bbox1[2] - bbox1[0]
    x1 = (w - w1) // 2 - bbox1[0]
    y1 = 90 - bbox1[1]
    
    # Line 2: 暑假
    font_line2 = get_font(FONT_YUANTI, 160)
    text_line2 = "暑  假"
    bbox2 = draw.textbbox((0, 0), text_line2, font=font_line2)
    w2 = bbox2[2] - bbox2[0]
    x2 = (w - w2) // 2 - bbox2[0]
    y2 = 270 - bbox2[1]
    
    # Render Line 1 in coral-red with navy outline
    render_text_with_outline(draw, (x1, y1), text_line1, font_line1,
                             fill_color=(245, 95, 100, 255),
                             outline_color=(24, 46, 78, 255),
                             outline_width=12)
    
    # Render Line 2 in cyan-blue with navy outline
    render_text_with_outline(draw, (x2, y2), text_line2, font_line2,
                             fill_color=(56, 182, 255, 255),
                             outline_color=(24, 46, 78, 255),
                             outline_width=14)
    
    # Draw fireworks & gold star sparkles
    def draw_star(cx, cy, r, color=(255, 200, 70, 255)):
        pts = [(cx, cy - r), (cx + r * 0.35, cy - r * 0.35), (cx + r, cy), 
               (cx + r * 0.35, cy + r * 0.35), (cx, cy + r), (cx - r * 0.35, cy + r * 0.35),
               (cx - r, cy), (cx - r * 0.35, cy - r * 0.35)]
        draw.polygon(pts, fill=color)
    
    # Fireworks bursts
    def draw_firework(cx, cy, r, color=(255, 230, 200, 180)):
        for i in range(12):
            ang = i * math.pi / 6
            x1 = cx + math.cos(ang) * (r * 0.4)
            y1 = cy + math.sin(ang) * (r * 0.4)
            x2 = cx + math.cos(ang) * r
            y2 = cy + math.sin(ang) * r
            draw.line([(x1, y1), (x2, y2)], fill=color, width=4)
    
    # Background fireworks
    fw_layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    fw_draw = ImageDraw.Draw(fw_layer)
    def draw_firework_on(d, cx, cy, r, color=(255, 240, 220, 160)):
        for i in range(12):
            ang = i * math.pi / 6
            x1 = cx + math.cos(ang) * (r * 0.4)
            y1 = cy + math.sin(ang) * (r * 0.4)
            x2 = cx + math.cos(ang) * r
            y2 = cy + math.sin(ang) * r
            d.line([(x1, y1), (x2, y2)], fill=color, width=5)
    
    draw_firework_on(fw_draw, 100, 120, 70, (255, 245, 230, 200))
    draw_firework_on(fw_draw, w - 120, 360, 80, (255, 230, 235, 200))
    draw_firework_on(fw_draw, w - 100, 130, 60, (255, 245, 220, 180))
    
    draw_star(120, 360, 22)
    draw_star(210, 390, 16)
    draw_star(w - 160, 120, 20)
    draw_star(w - 240, 420, 18)
    
    # Ghost flame on top of "巷" or "的"
    flame_pts = [(470, 75), (460, 50), (475, 25), (490, 45), (495, 65), (485, 80)]
    draw.polygon(flame_pts, fill=(245, 95, 100, 255))
    draw.line(flame_pts + [(470, 75)], fill=(24, 46, 78, 255), width=3)
    
    result = Image.alpha_composite(fw_layer, img)
    return result

def redraw_ogp(redrawn_logo):
    orig_path = os.path.join(MIRROR, 'assets/webp/ogp/ogp.webp')
    orig = Image.open(orig_path).convert('RGBA')
    w, h = orig.size
    
    # We want to replace the left logo and Japanese slogan with Chinese
    # Right side contains characters (from x: 500 to w)
    result = orig.copy()
    
    # Clean left text area (x: 0 to 520, y: 150 to 540) using background color gradient/pattern
    # Sample clean background from top left and bottom left
    bg_patch = orig.crop((0, 0, 520, h))
    draw_patch = ImageDraw.Draw(bg_patch)
    
    # Fill over old logo & text area with smooth pastel gradient matching original
    # (Original has soft cream/pinkish gradient)
    for y in range(120, 540):
        # Interpolate color from y=120 to y=540
        t = (y - 120) / (540 - 120)
        # soft pinkish-white to warm cream
        r = int(255 * (1 - t) + 248 * t)
        g = int(240 * (1 - t) + 230 * t)
        b = int(235 * (1 - t) + 220 * t)
        draw_patch.line([(0, y), (520, y)], fill=(r, g, b, 255))
    
    # Smooth patch transition to right side
    bg_patch = bg_patch.filter(ImageFilter.GaussianBlur(2))
    
    result.paste(bg_patch.crop((0, 120, 500, 540)), (0, 120))
    
    # Paste resized Chinese logo on left
    logo_resized = redrawn_logo.resize((460, int(460 * (510 / 1152))), Image.LANCZOS)
    result.paste(logo_resized, (30, 150), logo_resized)
    
    # Render subtitle:
    # "解决妖怪事件"
    # "让夏日祭圆满成功！"
    draw = ImageDraw.Draw(result)
    font_sub1 = get_font(FONT_YAHEI_BOLD, 36)
    font_sub2 = get_font(FONT_YAHEI_BOLD, 40)
    
    text_sub1 = "解决妖怪事件"
    text_sub2 = "让夏日祭大获成功！"
    
    draw.text((80, 395), text_sub1, font=font_sub1, fill=(90, 24, 32, 255))
    draw.text((50, 445), text_sub2, font=font_sub2, fill=(24, 110, 200, 255))
    
    return result.convert('RGB')

def main():
    print("Generating localized image assets...")
    
    # 1. Start button
    im_start = redraw_btn_start()
    im_start.save(os.path.join(MIRROR, 'assets/webp/index/btn_start.webp'), 'WEBP')
    print("  -> btn_start.webp")
    
    # 2. Post button
    im_post = redraw_btn_post()
    im_post.save(os.path.join(MIRROR, 'assets/webp/clear/btn_post.webp'), 'WEBP')
    print("  -> btn_post.webp")
    
    # 3. Share banner
    im_share = redraw_bnr_share()
    im_share.save(os.path.join(MIRROR, 'assets/webp/index/bnr_share.webp'), 'WEBP')
    print("  -> bnr_share.webp")
    
    # 4. Ending list title
    im_ending = redraw_ttl_endinglist()
    im_ending.save(os.path.join(MIRROR, 'assets/webp/common/ttl_endinglist.webp'), 'WEBP')
    print("  -> ttl_endinglist.webp")
    
    # 5. Clear title
    im_clear_ttl = redraw_ttl_clear()
    im_clear_ttl.save(os.path.join(MIRROR, 'assets/webp/clear/ttl_clear.webp'), 'WEBP')
    print("  -> ttl_clear.webp")
    
    # 6. Clear background text
    im_clear_txt = redraw_txt_clear()
    im_clear_txt.save(os.path.join(MIRROR, 'assets/webp/clear/txt_clear.webp'), 'WEBP')
    print("  -> txt_clear.webp")
    
    # 7. Main logo
    im_logo = redraw_logo()
    im_logo.save(os.path.join(MIRROR, 'assets/webp/common/logo_ayakashi-yokotyo.webp'), 'WEBP')
    print("  -> logo_ayakashi-yokotyo.webp")
    
    # 8. OGP
    im_ogp = redraw_ogp(im_logo)
    im_ogp.save(os.path.join(MIRROR, 'assets/webp/ogp/ogp.webp'), 'WEBP')
    print("  -> ogp.webp")
    
    print("All 8 image assets redrawn and saved successfully!")

if __name__ == '__main__':
    main()
