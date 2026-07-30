#!/usr/bin/env python3
"""Generate the PWA icon set.

The app ships an SVG icon, but iOS home-screen install and the Android
maskable-icon slot both require real PNGs. This renders them from the same
geometry as icon.svg so every size stays visually identical, with no image
library or build-time dependency.

Usage:  python3 scripts/generate-icons.py
Output: packages/web/public/icon-{180,192,512}.png and icon-maskable.png
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "packages" / "web" / "public"

# Brand gradient, matching manifest theme_color.
GRADIENT_TOP = (67, 56, 202)     # indigo-700
GRADIENT_BOTTOM = (124, 58, 237) # violet-600
GLYPH = (255, 255, 255)

# Supersampling factor: renders large, averages down, which is what gives the
# curves and diagonals clean edges without an antialiasing library.
SS = 4


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def point_in_polygon(x: float, y: float, polygon: list[tuple[float, float]]) -> bool:
    """Even-odd ray casting."""
    inside = False
    count = len(polygon)
    j = count - 1
    for i in range(count):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def inside_rounded_rect(x: float, y: float, size: float, radius: float) -> bool:
    if x < 0 or y < 0 or x > size or y > size:
        return False
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def bolt_polygon(size: float) -> list[tuple[float, float]]:
    """A spark/bolt glyph expressed in fractions of the canvas."""
    points = [
        (0.560, 0.130),
        (0.270, 0.560),
        (0.455, 0.560),
        (0.400, 0.870),
        (0.720, 0.430),
        (0.530, 0.430),
    ]
    return [(px * size, py * size) for px, py in points]


def render(size: int, maskable: bool) -> bytes:
    """Returns raw RGBA rows for one icon."""
    hi = size * SS
    # A maskable icon must survive an aggressive circular crop, so the artwork
    # is inset and the background fills the whole square.
    radius = hi * (0.5 if maskable else 0.22)
    scale = 0.74 if maskable else 1.0
    offset = hi * (1 - scale) / 2

    polygon = [(px * scale + offset, py * scale + offset) for px, py in bolt_polygon(hi)]

    # Accumulate per output pixel across the supersample grid.
    rows: list[bytearray] = []
    for out_y in range(size):
        row = bytearray()
        for out_x in range(size):
            r_sum = g_sum = b_sum = a_sum = 0
            for sy in range(SS):
                y = out_y * SS + sy + 0.5
                for sx in range(SS):
                    x = out_x * SS + sx + 0.5

                    if maskable:
                        in_bg = 0 <= x <= hi and 0 <= y <= hi
                    else:
                        in_bg = inside_rounded_rect(x, y, hi, radius)

                    if not in_bg:
                        continue

                    t = y / hi
                    br = lerp(GRADIENT_TOP[0], GRADIENT_BOTTOM[0], t)
                    bg = lerp(GRADIENT_TOP[1], GRADIENT_BOTTOM[1], t)
                    bb = lerp(GRADIENT_TOP[2], GRADIENT_BOTTOM[2], t)

                    if point_in_polygon(x, y, polygon):
                        br, bg, bb = GLYPH

                    r_sum += br
                    g_sum += bg
                    b_sum += bb
                    a_sum += 255

            samples = SS * SS
            alpha = a_sum / samples
            if alpha <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                # Un-premultiply so partially covered edge pixels keep their colour.
                coverage = a_sum / 255
                row += bytes(
                    (
                        round(r_sum / coverage),
                        round(g_sum / coverage),
                        round(b_sum / coverage),
                        round(alpha),
                    )
                )
        rows.append(row)

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    return png_bytes(size, size, raw)


def png_bytes(width: int, height: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [("icon-180.png", 180, False), ("icon-192.png", 192, False), ("icon-512.png", 512, False), ("icon-maskable.png", 512, True)]
    for filename, size, maskable in targets:
        path = OUT_DIR / filename
        path.write_bytes(render(size, maskable))
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()
