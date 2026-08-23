#!/usr/bin/env python3
"""Redraw the Listboard mark as raster icons.

favicon.svg is the real icon; everything this writes is a fallback for the
places that cannot take an SVG (Safari's tab, iOS home screens, PWA installs,
link previews). One geometry, defined once below, so the raster copies can
never drift away from the vector.

    python tools/make-icons.py

Run by hand, never at deploy. Requires Pillow.
"""

import os
from PIL import Image, ImageDraw

# The mark: three lanes on a near-black tile, in the dark theme's yellow.
# Coordinates are the favicon.svg viewBox, 0..40, scaled up at draw time.
VIEW = 40.0
BG = "#131211"          # --bg, dark
FG = "#facc15"          # --accent, dark
TILE_RADIUS = 8.0       # rounded corner of the tile itself

# Lanes match the brand mark in the nav rail: three 9-wide lanes at x 4, 15.5
# and 27, so the 4 units of margin are equal on both sides.
LANE_Y, LANE_H = 7.0, 26.0
LANE_W, LANE_GAP = 9.0, 2.5
LANE_X0 = 4.0
LANE_RADIUS = 2.8
# Thinner than favicon.svg draws it. That file is built to survive 16px, where
# a hairline disappears; at 192 and up the same stroke reads as a slab and
# swallows the cards inside it.
LANE_STROKE = 1.9

# Cards inside the lanes, as (lane index, y, height). The middle lane carries
# two and the last one is topped out: the picture says "work moving along".
CARDS = [(0, 10.4, 4.6), (1, 10.4, 4.6), (1, 16.4, 4.6), (2, 10.4, 4.6)]
CARD_W = 3.4
CARD_INSET = (LANE_W - CARD_W) / 2   # centred, so both walls keep clear air
CARD_RADIUS = 1.3

# What to write. The 512 is the general-purpose one: PWA manifests, link
# previews, anywhere a big square is wanted.
SIZES = {
    "assets/icon-512.png": 512,
    "assets/icon-192.png": 192,
    "assets/apple-touch-icon.png": 180,
}

# A maskable icon is cropped to whatever shape the platform fancies, and only
# the middle 80% is guaranteed to survive. The normal mark runs nearly edge to
# edge, so its outer lanes would be shaved off; this one is drawn smaller on a
# full-bleed tile instead.
MASKABLE = ("assets/icon-512-maskable.png", 512)
MASKABLE_SAFE = 0.78
ICO_SIZES = [16, 32, 48]

# Supersample, then downscale: Pillow has no anti-aliased shape drawing, so
# the smooth edges have to come from the resize.
SS = 4


def lane_x(i):
    return LANE_X0 + i * (LANE_W + LANE_GAP)


# Below this, the outlined lanes and the cards inside them stop being legible
# and turn into three yellow smudges. Small sizes fill the lanes solid instead.
# Same three lanes, same positions, same silhouette as the big icon, at the
# only weight that survives a browser tab. Varying the heights was tried and
# rejected: it reads as a bar chart, which is a different product.
SMALL_ABOVE = 64


def draw_mark(px, tile=True):
    """Render the mark at px by px and return the image."""
    big = px * SS
    k = big / VIEW  # viewBox units to pixels

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if tile:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=TILE_RADIUS * k, fill=BG)

    if px < SMALL_ABOVE:
        for i in range(3):
            x = lane_x(i)
            d.rounded_rectangle(
                [x * k, LANE_Y * k, (x + LANE_W) * k, (LANE_Y + LANE_H) * k],
                radius=LANE_RADIUS * k, fill=FG,
            )
        return img.resize((px, px), Image.LANCZOS)

    w = max(1, round(LANE_STROKE * k))
    for i in range(3):
        x = lane_x(i)
        d.rounded_rectangle(
            [x * k, LANE_Y * k, (x + LANE_W) * k, (LANE_Y + LANE_H) * k],
            radius=LANE_RADIUS * k, outline=FG, width=w,
        )

    for i, y, h in CARDS:
        x = lane_x(i) + CARD_INSET
        d.rounded_rectangle(
            [x * k, y * k, (x + CARD_W) * k, (y + h) * k],
            radius=CARD_RADIUS * k, fill=FG,
        )

    return img.resize((px, px), Image.LANCZOS)


def draw_maskable(px):
    """The mark shrunk into the safe zone, on a tile that fills the canvas."""
    img = Image.new("RGBA", (px, px), BG)
    inner = draw_mark(int(px * MASKABLE_SAFE), tile=False)
    off = (px - inner.size[0]) // 2
    img.paste(inner, (off, off), inner)
    return img


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(os.path.join(root, "assets"), exist_ok=True)

    for name, px in SIZES.items():
        path = os.path.join(root, name)
        draw_mark(px).save(path)
        print("wrote {} ({}x{})".format(name, px, px))

    name, px = MASKABLE
    draw_maskable(px).save(os.path.join(root, name))
    print("wrote {} ({}x{}, maskable)".format(name, px, px))

    # The .ico is drawn at each size rather than downscaled from one, so the
    # 16px copy keeps its lanes instead of turning to mush. Pillow drops any
    # requested size larger than the base image, so the base has to be the
    # biggest frame and the rest ride along in append_images.
    ico = os.path.join(root, "favicon.ico")
    sizes = sorted(ICO_SIZES, reverse=True)
    frames = [draw_mark(s) for s in sizes]
    frames[0].save(ico, format="ICO", sizes=[(s, s) for s in sizes],
                   append_images=frames[1:])
    written = sorted(s[0] for s in Image.open(ico).info.get("sizes", []))
    print("wrote favicon.ico ({})".format(", ".join(str(s) for s in written)))


if __name__ == "__main__":
    main()
