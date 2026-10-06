"""Bird sprite sheets for the ambient layer (5 Oct 2026).

Reads Matthew's three ChatGPT strips (src_*.png: four top-down frames side by
side, head up, transparent background, frames not on an exact grid) and writes
assets/ambient/birds/<name>.webp: four equal cells in a row, every frame placed
so the bird's body sits at the same point in its cell (aligned on the body's
centre line and the beak tip), plus <name>.json with the cell size and how wide
the spread-wing frame is, so the game can scale a bird to its wingspan.

Frame order in the sheet is as drawn: 0 wings spread (also the glide),
1 raised, 2 down, 3 halfway. The game plays a flap as 0, 2, 3, 1.

Run: python3 tools/birds/make-bird-sheets.py
"""
import json, os
from PIL import Image

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, '..', '..', 'assets', 'ambient', 'birds')
CELL = 160          # output cell width in px; the largest bird is about 28 css px wide (84 on a 3x phone)

def frames_of(im):
    a = im.getchannel('A')
    W, H = im.size
    cols = [any(a.getpixel((x, y)) > 20 for y in range(0, H, 3)) for x in range(W)]
    runs, s = [], None
    for x, c in enumerate(cols):
        if c and s is None: s = x
        if not c and s is not None: runs.append((s, x)); s = None
    if s is not None: runs.append((s, W))
    runs = [r for r in runs if r[1] - r[0] > 40]
    # Two frames can touch (the buzzard's spread and raised wingtips do):
    # split the widest run at its thinnest column until there are four.
    while len(runs) < 4:
        i = max(range(len(runs)), key=lambda k: runs[k][1] - runs[k][0])
        a0, a1 = runs[i]
        lo, hi = a0 + (a1 - a0) // 3, a1 - (a1 - a0) // 3
        cut = min(range(lo, hi), key=lambda x: sum(a.getpixel((x, y)) > 20 for y in range(0, H, 2)))
        runs[i:i + 1] = [(a0, cut), (cut, a1)]
    assert len(runs) == 4, runs
    out = []
    for a0, a1 in runs:
        sub = im.crop((a0, 0, a1, H))
        bb = sub.getbbox()
        cx = (bb[0] + bb[2]) / 2           # the bird is symmetric: its body is the centre line
        A = sub.getchannel('A')
        beak = next(y for y in range(H) if any(A.getpixel((int(cx) + d, y)) > 60 for d in range(-4, 5)))
        out.append((sub, cx, beak, bb))
    return out

def build(name):
    im = Image.open(os.path.join(HERE, f'src_{name}.png')).convert('RGBA')
    fr = frames_of(im)
    # extents of every frame relative to its (cx, beak) anchor
    left = max(cx - bb[0] for _, cx, _, bb in fr); right = max(bb[2] - cx for _, cx, _, bb in fr)
    up = max(beak - bb[1] for _, _, beak, bb in fr); down = max(bb[3] - beak for _, _, beak, bb in fr)
    half = max(left, right)
    srcW, srcH = 2 * half, up + down
    s = CELL / srcW
    cellH = round(srcH * s)
    sheet = Image.new('RGBA', (CELL * 4, cellH), (0, 0, 0, 0))
    for i, (sub, cx, beak, bb) in enumerate(fr):
        cell = Image.new('RGBA', (round(srcW), round(srcH)), (0, 0, 0, 0))
        cell.paste(sub, (round(half - cx), round(up - beak)), sub)
        cell = cell.resize((CELL, cellH), Image.LANCZOS)
        sheet.paste(cell, (i * CELL, 0))
    sheet.save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=90, method=6)
    _, cx0, beak0, bb0 = fr[0]
    meta = {
        'frames': 4, 'cellW': CELL, 'cellH': cellH,
        'spreadSpan': round((bb0[2] - bb0[0]) * s, 1),          # px of the cell the spread wings cover
        'bodyX': CELL / 2,                                     # the body's centre line
        'bodyY': round((up + ((bb0[1] + bb0[3]) / 2 - beak0)) * s, 1),   # mid-body of the spread frame
        'order': ['spread', 'raised', 'down', 'halfway'],
        'flap': [0, 2, 3, 1],
    }
    json.dump(meta, open(os.path.join(OUT, f'{name}.json'), 'w'), indent=1)
    print(name, sheet.size, meta)

for n in ('partridge', 'goose', 'buzzard'):
    build(n)
