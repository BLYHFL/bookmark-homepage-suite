#!/usr/bin/env python3
"""生成扩展图标:圆角渐变底 + 白色书签丝带图形。纯 Python,无第三方依赖。"""
import struct
import zlib
import os

def clamp(v):
    return max(0, min(255, int(v)))

def rounded_rect_sdf(x, y, size, radius):
    """到圆角矩形边缘的有符号距离(负值在内部)"""
    half = size / 2
    dx = abs(x - half) - (half - radius)
    dy = abs(y - half) - (half - radius)
    ox = max(dx, 0)
    oy = max(dy, 0)
    return (ox * ox + oy * oy) ** 0.5 + min(max(dx, dy), 0) - radius

def glyph_inside(x, y, size):
    """白色书签丝带:竖矩形 + 底部 V 形缺口"""
    left, right = size * 0.38, size * 0.62
    top, bottom = size * 0.22, size * 0.78
    if not (left <= x <= right and top <= y <= bottom):
        return False
    notch_apex = size * 0.62          # 缺口顶点(中央最高处)
    t = abs(x - size / 2) / ((right - left) / 2)  # 0 中央,1 边缘
    cut_start = notch_apex + (bottom - notch_apex) * t
    return y < cut_start

def pixel(x, y, size):
    radius = size * 0.22
    d = rounded_rect_sdf(x + 0.5, y + 0.5, size, radius)
    if d > 0.5:
        return (0, 0, 0, 0)
    t = y / size
    r = clamp(0x6E + (0x3D - 0x6E) * t)   # 顶部 #6EA8FF → 底部 #3D5AFE
    g = clamp(0xA8 + (0x5A - 0xA8) * t)
    b = clamp(0xFF + (0xFE - 0xFF) * t)
    # 边缘一圈抗锯齿淡出
    if glyph_inside(x + 0.5, y + 0.5, size):
        r = g = b = 255
    a = 255 if d < -0.5 else clamp(255 * (0.5 - d))
    return (r, g, b, a)

def write_png(path, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(pixel(x, y, size))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)

here = os.path.dirname(os.path.abspath(__file__))
for s in (16, 48, 128):
    write_png(os.path.join(here, f"icon{s}.png"), s)
    print(f"icon{s}.png OK")
