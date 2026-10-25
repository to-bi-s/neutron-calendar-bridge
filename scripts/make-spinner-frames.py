#!/usr/bin/env python3
"""
The frames of the spinning sync symbol in the menu-bar menu (0.32.4): the two-arrow symbol of
resources/icons/menu/account-syncing.png, drawn large, turned clockwise in 12 steps of 15° (the
symbol repeats itself every 180°, so that is one visible turn) and scaled to 16 px (+@2x) →
resources/icons/menu/spinner/frame-NN.png. 0.45.2: the same in the yellow of account-warning.png →
resources/icons/menu/spinner-warning/ (syncing while something needs attention), and the still symbol in
yellow → account-syncing-warning.png. 0.46: the same in blue (the first pass after the app started:
nothing verified yet) → spinner-initial/ and account-syncing-initial.png; the "connecting" dots
(status-connecting, account-connecting) turn blue, and the yellow status dot moves to status-warning.png
(Proton asked to slow down). Run once when the symbol changes (needs Pillow):
python3 scripts/make-spinner-frames.py
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'resources', 'icons', 'menu', 'spinner')
GREEN = (48, 182, 69, 255)
YELLOW = (248, 181, 0, 255)  # the yellow of account-warning.png
BLUE = (14, 165, 233, 255)  # 0.46: connecting, nothing verified yet (readable on light and dark menus)
FRAMES = 12
BIG = 512


def arc_points(cx, cy, r, start, end, steps=60):
    return [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in [start + (end - start) * i / steps for i in range(steps + 1)]]


def draw_symbol(angle, colour=GREEN):
    """Two arcs with arrowheads, like the static icon; angle turns the whole symbol clockwise."""
    im = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    cx = cy = BIG / 2
    r = BIG * 0.27
    width = int(BIG * 0.10)
    head = BIG * 0.18
    for base in (0, 180):
        # An arc over ~150° (PIL angles are clockwise, 0° = 3 o'clock); the arrowhead at its end.
        start = base + 205
        end = base + 325
        pts = arc_points(cx, cy, r, start, end)
        draw.line(pts, fill=colour, width=width, joint='curve')
        for p in (pts[0], pts[-1]):
            draw.ellipse([p[0] - width / 2, p[1] - width / 2, p[0] + width / 2, p[1] + width / 2], fill=colour)
        # Arrowhead: a triangle pointing along the arc's direction at its end.
        ex, ey = pts[-1]
        tangent = math.radians(end + 90)  # clockwise travel
        tx, ty = math.cos(tangent), math.sin(tangent)
        nx, ny = -ty, tx
        tip = (ex + tx * head * 0.9, ey + ty * head * 0.9)
        left = (ex + nx * head * 0.75, ey + ny * head * 0.75)
        right = (ex - nx * head * 0.75, ey - ny * head * 0.75)
        draw.polygon([tip, left, right], fill=colour)
    return im.rotate(-angle, resample=Image.BICUBIC, center=(cx, cy))


def main():
    for folder, colour in (('spinner', GREEN), ('spinner-warning', YELLOW), ('spinner-initial', BLUE)):
        out = os.path.join(HERE, '..', 'resources', 'icons', 'menu', folder)
        os.makedirs(out, exist_ok=True)
        for index in range(FRAMES):
            big = draw_symbol(index * 180 / FRAMES, colour)
            big.resize((32, 32), Image.LANCZOS).save(os.path.join(out, f'frame-{index:02d}@2x.png'))
            big.resize((16, 16), Image.LANCZOS).save(os.path.join(out, f'frame-{index:02d}.png'))
        print(f'{FRAMES} frames written to {os.path.relpath(out)}')
    # The still symbol in yellow and (0.46) blue: account-syncing.png in that colour.
    for name, colour in (('account-syncing-warning', YELLOW), ('account-syncing-initial', BLUE)):
        recolour('account-syncing', name, colour)
    # 0.46: the yellow status dot becomes the "slowed down" one; connecting turns blue. In this order, so
    # running the script again gives the same result.
    recolour('status-connecting', 'status-warning', YELLOW)
    recolour('status-connecting', 'status-connecting', BLUE)
    recolour('account-connecting', 'account-connecting', BLUE)
    print('account-syncing-warning/-initial, status-warning, status-connecting and account-connecting written')


def recolour(source_name, target_name, colour):
    """A one-colour icon (+@2x) in another colour, keeping its shape (the alpha channel)."""
    for suffix in ('', '@2x'):
        source = Image.open(os.path.join(HERE, '..', 'resources', 'icons', 'menu', f'{source_name}{suffix}.png')).convert('RGBA')
        pixels = [(colour[0], colour[1], colour[2], a) for (_r, _g, _b, a) in source.getdata()]
        image = Image.new('RGBA', source.size)
        image.putdata(pixels)
        image.save(os.path.join(HERE, '..', 'resources', 'icons', 'menu', f'{target_name}{suffix}.png'))

if __name__ == '__main__':
    main()
