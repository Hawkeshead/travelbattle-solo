"""Placeholder unit-figure sprite sheets (Unit Figures brief, section 8).

Writes assets/units/{nation}/{unitType}/{anim}_{facing}.webp strips in the
final format (section 9), plus one sidecar JSON per unit type. Deliberately
crude: a nation-coloured figure, a wider shape for cavalry, a grey block for
the cannon, the frame number printed small on every frame, and each state
given an obvious motion so it can be told apart in a screenshot. Real
3D-rendered sheets replace these file for file.

Run: python3 tools/units/make-placeholders.py
"""
import json, math, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'units')
COL = {'british': (178, 34, 34), 'french': (34, 64, 150)}
TROUSERS = {'british': (60, 60, 70), 'french': (235, 235, 235)}
FONT = ImageFont.load_default()
ANIMS = {  # frameCount, fps, loop
    'idle': (4, 6, True), 'march': (6, 12, True), 'fire': (4, 12, False),
    'melee': (4, 10, True), 'fall': (6, 12, False), 'flee': (6, 14, True),
}

def man(d, w, h, nation, facing, f, anim, tall=False, armed=True):
    """One standing (or falling) man, feet at bottom centre."""
    cx, base = w / 2, h - 4
    bob = lean = 0.0
    stride = 0
    tilt = 0.0
    if anim == 'idle': bob = 2 * math.sin(f / 4 * 2 * math.pi)
    if anim in ('march', 'flee'): stride = 6 * math.sin(f / 6 * 2 * math.pi)
    if anim == 'melee': lean = 7 * math.sin(f / 4 * 2 * math.pi)
    if anim == 'flee': tilt = 0.35
    if anim == 'fall':
        k = f / 5  # 0..1, last frame lying down
        return body_lying(d, w, h, nation, k)
    side = {'left': -1, 'right': 1}.get(facing, 0)
    top = base - 52 - bob
    hx = cx + lean * (1 if facing != 'away' else -1) + tilt * 14
    # legs
    d.line([(cx - 4 + stride, base), (cx - 3, base - 20)], fill=TROUSERS[nation], width=5)
    d.line([(cx + 4 - stride, base), (cx + 3, base - 20)], fill=TROUSERS[nation], width=5)
    # coat
    d.polygon([(cx - 9 + tilt * 6, base - 20), (cx + 9 + tilt * 6, base - 20), (hx + 8, top + 14), (hx - 8, top + 14)], fill=COL[nation])
    # head and hat
    face = (232, 196, 160) if facing != 'away' else (90, 60, 40)
    d.ellipse([hx - 6, top + 2, hx + 6, top + 14], fill=face)
    if tall: d.rectangle([hx - 7, top - 12, hx + 7, top + 4], fill=(20, 20, 20))
    else: d.rectangle([hx - 7, top - 3, hx + 7, top + 4], fill=(25, 25, 25))
    if facing == 'toward': d.point([(hx - 2, top + 8), (hx + 2, top + 8)], fill=(0, 0, 0))
    if armed:
        mx = hx + 9 + side * 4
        d.line([(mx, top + 30), (mx + side * 6, top - 6)], fill=(110, 80, 40), width=2)
        if anim == 'fire' and f in (1, 2):
            d.ellipse([mx + side * 6 - 7, top - 18, mx + side * 6 + 7, top - 4], fill=(255, 220, 90))

def body_lying(d, w, h, nation, k):
    """Toppling over: k=0 upright-ish, k=1 lying flat (the body frame)."""
    cx, base = w / 2, h - 4
    ang = k * math.pi / 2
    L = 50
    tx, ty = cx + L * math.sin(ang), base - L * math.cos(ang)
    d.line([(cx, base), (tx, ty)], fill=COL[nation], width=10)
    d.ellipse([tx - 6, ty - 6, tx + 6, ty + 6], fill=(232, 196, 160))

def rider(d, w, h, nation, facing, f, anim):
    cx, base = w / 2, h - 4
    if anim == 'fall':
        k = f / 5
        d.ellipse([cx - 30, base - 24 + 10 * k, cx + 30, base - 4], fill=(110, 75, 45))
        d.line([(cx - 10, base - 22), (cx - 10 + 30 * k, base - 22 - 20 * (1 - k))], fill=COL[nation], width=8)
        return
    gallop = 3 * math.sin(f / 6 * 2 * math.pi) if anim in ('march', 'flee', 'melee') else 1 * math.sin(f / 4 * 2 * math.pi)
    tilt = 8 if anim == 'flee' else 0
    # horse
    d.ellipse([cx - 30, base - 36 - gallop, cx + 26, base - 16 - gallop], fill=(120, 80, 45))
    for lx in (-22, -12, 10, 20):
        d.line([(cx + lx, base - 18 - gallop), (cx + lx + (gallop * 2 if lx > 0 else -gallop * 2), base)], fill=(90, 60, 35), width=4)
    hd = 28 if facing != 'away' else -32
    d.ellipse([cx + hd - 6, base - 50 - gallop, cx + hd + 8, base - 32 - gallop], fill=(120, 80, 45))
    # rider
    top = base - 72 - gallop
    lean = 8 * math.sin(f / 4 * 2 * math.pi) if anim == 'melee' else 0
    d.rectangle([cx - 7 + lean + tilt, top + 14, cx + 7 + lean + tilt, top + 38], fill=COL[nation])
    face = (232, 196, 160) if facing != 'away' else (90, 60, 40)
    d.ellipse([cx - 6 + lean + tilt, top + 2, cx + 6 + lean + tilt, top + 14], fill=face)
    d.rectangle([cx - 7 + lean + tilt, top - 6, cx + 7 + lean + tilt, top + 4], fill=(30, 30, 30))
    if anim == 'melee' or anim == 'fire':
        d.line([(cx + 8 + lean, top + 18), (cx + 24 + lean, top - 4)], fill=(210, 210, 220), width=2)

def cannon(d, w, h, nation, facing, f, anim):
    cx, base = w / 2, h - 6
    if anim == 'wreck':
        d.polygon([(cx - 34, base), (cx + 30, base - 6), (cx + 26, base - 22), (cx - 30, base - 14)], fill=(70, 70, 70))
        d.ellipse([cx - 40, base - 20, cx - 20, base], outline=(40, 40, 40), width=4)
        return
    recoil = [0, -10, -6, -2][f % 4] if anim == 'fire' else 0
    dirn = 1 if facing != 'away' else -1
    d.ellipse([cx - 22 + recoil, base - 22, cx + 2 + recoil, base + 2], outline=(60, 45, 30), width=5)
    d.rectangle([cx - 30 + recoil, base - 30, cx + 30 + recoil, base - 16], fill=(120, 120, 125))
    x0, x1 = sorted([cx + dirn * 18 + recoil, cx + dirn * 44 + recoil])
    d.rectangle([x0, base - 28, x1, base - 20], fill=(90, 90, 95))
    if anim == 'fire' and f == 1:
        fx = cx + dirn * 44
        d.ellipse([fx - 14, base - 40, fx + 14, base - 8], fill=(255, 220, 90))

TYPES = {
    'INFANTRY':     dict(size=(48, 72), facings=['toward', 'away', 'left', 'right'], draw=lambda d, w, h, n, fa, f, a: man(d, w, h, n, fa, f, a)),
    'GUARD':        dict(size=(48, 72), facings=['toward', 'away', 'left', 'right'], draw=lambda d, w, h, n, fa, f, a: man(d, w, h, n, fa, f, a, tall=True)),
    'LIGHT_CAV':    dict(size=(80, 84), facings=['toward', 'away'], draw=rider),
    'HEAVY_CAV':    dict(size=(80, 84), facings=['toward', 'away'], draw=rider),
    'ARTILLERY':    dict(size=(48, 72), facings=['toward', 'away'], draw=lambda d, w, h, n, fa, f, a: man(d, w, h, n, fa, f, a, armed=False)),
    'ARTILLERY_GUN': dict(size=(104, 56), facings=['toward', 'away'], draw=cannon, anims={'idle': (1, 6, True), 'fire': (4, 12, False), 'wreck': (1, 6, False)}),
}
DISPLAY = {'INFANTRY': 0.30, 'GUARD': 0.32, 'LIGHT_CAV': 0.36, 'HEAVY_CAV': 0.40, 'ARTILLERY': 0.27, 'ARTILLERY_GUN': 0.34}

def main():
    count = 0
    for nation in ('british', 'french'):
        for t, spec in TYPES.items():
            w, h = spec['size']
            anims = spec.get('anims', ANIMS)
            folder = os.path.join(ROOT, nation, t)
            os.makedirs(folder, exist_ok=True)
            meta = {'frameWidth': w, 'frameHeight': h, 'anchorX': 0.5, 'anchorY': 1.0,
                    'displayScale': DISPLAY[t], 'anims': {}}
            for a, (n, fps, loop) in anims.items():
                meta['anims'][a] = {'frameCount': n, 'fps': fps, 'loop': loop}
                for fa in spec['facings']:
                    strip = Image.new('RGBA', (w * n, h), (0, 0, 0, 0))
                    for f in range(n):
                        fr = Image.new('RGBA', (w, h), (0, 0, 0, 0))
                        d = ImageDraw.Draw(fr)
                        spec['draw'](d, w, h, nation, fa, f, a)
                        d.text((2, 1), str(f), fill=(255, 255, 255, 230), font=FONT)
                        strip.paste(fr, (f * w, 0))
                    strip.save(os.path.join(folder, f'{a}_{fa}.webp'), 'WEBP', lossless=True)
                    count += 1
            meta['facings'] = spec['facings']
            with open(os.path.join(folder, f'{t}.json'), 'w') as fh:
                json.dump(meta, fh, indent=1)
    print(count, 'sheets written')

if __name__ == '__main__':
    main()
