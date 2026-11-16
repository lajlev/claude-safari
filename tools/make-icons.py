#!/usr/bin/env python3
"""Render a generic orange spark/asterisk icon to PNGs (needs Pillow).

Usage: python3 tools/make-icons.py [output_dir]
"""
import math
import os
import sys

from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 96, 128]
ORANGE = (232, 121, 58, 255)
SUPERSAMPLE = 8


def render(size):
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = s / 2
    rays = 8
    for i in range(rays):
        a = math.pi * 2 * i / rays + math.pi / 8
        long_ray = i % 2 == 0
        r_out = s * (0.46 if long_ray else 0.36)
        w = s * (0.13 if long_ray else 0.10)
        x2, y2 = c + r_out * math.cos(a), c + r_out * math.sin(a)
        d.line([(c, c), (x2, y2)], fill=ORANGE, width=int(w))
        rr = w / 2
        d.ellipse([x2 - rr, y2 - rr, x2 + rr, y2 + rr], fill=ORANGE)
    core = s * 0.12
    d.ellipse([c - core, c - core, c + core, c + core], fill=ORANGE)
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(out, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out, f"icon-{size}.png")
        render(size).save(path)
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
