"""Turn the uploaded Ria logo into a multi-size .ico for the Windows exe.

The source is a 2048x2048 sheet: a dark charcoal background with the glyph
in the middle. Windows icons are composited on arbitrary backgrounds, so the
glyph is cropped to its own bounds and placed on a transparent canvas.
"""
import os
import sys
from PIL import Image

SRC = sys.argv[1]
OUT = sys.argv[2]
SIZES = [16, 32, 48, 64, 128, 256]

im = Image.open(SRC).convert("RGBA")
w, h = im.size
print(f"source: {w}x{h}")

# --- find the glyph: pixels that are clearly warm (orange/pink/purple) -----
px = im.load()
minx, miny, maxx, maxy = w, h, 0, 0
step = max(1, w // 512)
for y in range(0, h, step):
    for x in range(0, w, step):
        r, g, b, a = px[x, y]
        if a > 200 and r > 110 and b > 70 and (r - g) > 25 and r > b - 60:
            if x < minx: minx = x
            if y < miny: miny = y
            if x > maxx: maxx = x
            if y > maxy: maxy = y

if maxx <= minx or maxy <= miny:
    sys.exit("could not locate the glyph")

# The sheet has small detached fragments (stray blocks) that would inflate the
# box. Measure the dense core instead: a warm pixel counts only when its
# row/column neighbourhood is also warm.
mask = Image.new("L", (w, h), 0)
mp = mask.load()
for y in range(0, h, step):
    for x in range(0, w, step):
        r, g, b, a = px[x, y]
        if a > 200 and r > 110 and b > 70 and (r - g) > 25 and r > b - 60:
            mp[x, y] = 255
# Count warm pixels per coarse grid cell; keep cells in the main cluster.
cell = max(1, w // 64)
cols = {}
rows = {}
for y in range(0, h, step):
    for x in range(0, w, step):
        if mp[x, y] == 255:
            cols[x // cell] = cols.get(x // cell, 0) + 1
            rows[y // cell] = rows.get(y // cell, 0) + 1
if not cols:
    sys.exit("empty glyph mask")
xs = sorted(cols)
ys = sorted(rows)
minx, maxx = xs[0] * cell, min(w, (xs[-1] + 1) * cell)
miny, maxy = ys[0] * cell, min(h, (ys[-1] + 1) * cell)
print(f"dense core: {minx},{miny} - {maxx},{maxy}")

pad = int(max(maxx - minx, maxy - miny) * 0.09)
box = (max(0, minx - pad), max(0, miny - pad), min(w, maxx + pad), min(h, maxy + pad))
print(f"glyph box: {box}  ({box[2]-box[0]}x{box[3]-box[1]})")

glyph = im.crop(box)

# --- make the background transparent --------------------------------------
# The sheet has a near-black background; key it out by luminance, keeping the
# glyph's own colours. A soft alpha ramp avoids a hard, jagged edge.
g = glyph.load()
gw, gh = glyph.size
for y in range(gh):
    for x in range(gw):
        r, gg, b, a = g[x, y]
        lum = (r * 299 + gg * 587 + b * 114) // 1000
        if lum <= 42:
            g[x, y] = (r, gg, b, 0)
        elif lum < 70:
            # edge: fade toward transparent so the cut is not pixel-jagged
            g[x, y] = (r, gg, b, int(a * (lum - 42) / 28))

# --- square canvas, glyph centred ----------------------------------------
# Centre the *content*, not the crop: alpha-weighted centre of mass keeps the
# mark visually centred even when it has a detached top block.
alpha = glyph.split()[3]
tot = 0
sx = sy = 0
small = alpha.resize((gw // 4 or 1, gh // 4 or 1))
sw, sh = small.size
sp = small.load()
for y in range(sh):
    for x in range(sw):
        v = sp[x, y]
        if v:
            tot += v
            sx += x * v
            sy += y * v
com_x = (sx / tot / sw) * gw if tot else gw / 2
com_y = (sy / tot / sh) * gh if tot else gh / 2

side = int(max(gw, gh) * 1.06)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
off_x = int(side / 2 - com_x)
off_y = int(side / 2 - com_y)
canvas.paste(glyph, (off_x, off_y), glyph)
print(f"com ({com_x:.0f},{com_y:.0f}) -> canvas {side}px, offset ({off_x},{off_y})")

# --- downscale with a proper filter per size ------------------------------
# Sharp small sizes: the outline detail (the offset shadow lines) is what
# makes this mark readable at 16px, so mild sharpening is applied below 48px.
frames = []
for s in SIZES:
    small = canvas.resize((s, s), Image.LANCZOS)
    if s <= 48:
        from PIL import ImageFilter, ImageEnhance
        small = small.filter(ImageFilter.UnsharpMask(radius=0.8, percent=90, threshold=2))
    frames.append(small)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
print(f"wrote {OUT} with sizes {SIZES}")

# also drop a PNG preview so the result can be inspected
preview = os.path.join(os.path.dirname(OUT), "ria-icon-256.png")
frames[-1].save(preview)
print(f"preview {preview}")
