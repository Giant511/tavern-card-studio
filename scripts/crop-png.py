"""纯标准库 PNG 裁剪（无第三方依赖）。

用途：把 2x 截图里"问题标记"那一小块裁出来放大，作为 docs 配图。
只支持本项目生成的 PNG（8-bit RGBA/RGB、非隔行），足够用。
"""

import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    idat = b''
    width = height = bit_depth = color_type = None
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if ctype == b'IHDR':
            width, height, bit_depth, color_type = struct.unpack('>IIBB', body[:10])
        elif ctype == b'IDAT':
            idat += body
        elif ctype == b'IEND':
            break
        pos += 12 + length
    assert bit_depth == 8, f'unsupported bit depth {bit_depth}'
    assert color_type in (2, 6), f'unsupported color type {color_type}'
    channels = 3 if color_type == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * channels
    pixels = bytearray(width * height * channels)

    prev = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        ftype = raw[start]
        line = bytearray(raw[start + 1:start + 1 + stride])
        if ftype == 1:      # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:    # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:    # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:    # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        pixels[y * stride:(y + 1) * stride] = line
        prev = line

    return width, height, channels, pixels


def write_png(path, width, height, channels, pixels, scale=1):
    color_type = 2 if channels == 3 else 6
    out = bytearray()
    for y in range(height * scale):
        src_y = y // scale
        row = bytearray()
        for x in range(width * scale):
            src_x = x // scale
            off = (src_y * width + src_x) * channels
            row += pixels[off:off + channels]
        out += b'\x00' + row

    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body
                + struct.pack('>I', zlib.crc32(tag + body) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', width * scale, height * scale, 8, color_type, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(bytes(out), 9)) + chunk(b'IEND', b''))
    open(path, 'wb').write(png)


def main():
    src, dst, x0, y0, w, h, scale = sys.argv[1:8]
    x0, y0, w, h, scale = int(x0), int(y0), int(w), int(h), int(scale)
    width, height, channels, pixels = read_png(src)
    assert x0 + w <= width and y0 + h <= height, 'crop out of range'

    cropped = bytearray()
    for y in range(y0, y0 + h):
        start = (y * width + x0) * channels
        cropped += pixels[start:start + w * channels]

    write_png(dst, w, h, channels, cropped, scale)
    print(f'{dst}: {w}x{h} -> x{scale} = {w * scale}x{h * scale}')


if __name__ == '__main__':
    main()
