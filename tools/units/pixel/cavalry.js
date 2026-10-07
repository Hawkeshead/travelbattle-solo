/* Grognards pixel cavalry: British heavy dragoon (1st Royal Dragoons style) on a horse seen at three-quarters.
   Canvas 64 x 64, hooves on the bottom rows, centre x 32. Views: toward (three-quarter front, heading down-right),
   away (three-quarter rear, heading up-left). Poses: stand, stand2, walk1-4, gallop1-4, slash1, slash2, hit, down.
   Rider scale matches the 40 px infantry. */
const CAV = (() => {
  const W = 64, H = 64;
  const SK = [['#ecc39c', '#c99a72'], ['#dca97c', '#b8865c'], ['#f2d2ae', '#d2ad86'], ['#d49b70', '#ad774e'], ['#e6b88f', '#c39168']];
  const HR = [['#6a4426', '#4a2e18'], ['#d6b25a', '#a8863a'], ['#2c241c', '#18120c'], ['#b4532a', '#86391a'], ['#4a3020', '#2e1c12']];
  // horse coats: [main, light, dark, mane/points]
  const HORSE = [['#7a4524', '#94603a', '#5a3018', '#1e1612'], ['#2c2420', '#443a34', '#1a1512', '#100c0a'], ['#9a5a26', '#b47640', '#74401a', '#7a4218'],
                 ['#5a3a24', '#74503a', '#3e2616', '#1a1410'], ['#7a4524', '#94603a', '#5a3018', '#1e1612']];
  const C = { D: '#1d1a17', d: '#3d3832', B: '#e6b422', b: '#a87a12', W: '#f6f3ea', w: '#cfcabd', I: '#d8dce2', i: '#8a8f98', E: '#24160c', M: '#a0524a', MO: '#5a1e18', HOOF: '#2a2420', TACK: '#3a2a1e' };
  const SPECS = {
    // British heavy: 1st Royal Dragoons. Red coat, blue facings, brass helmet with a black crest.
    gb_heavy: { coat: '#c8191e', coatDk: '#8f1014', fac: '#203a8a', breech: '#d8d4c8', breechDk: '#b0ab9e', cloth: '#203a8a', clothDk: '#152860', lace: '#e6c54a', crest: '#151210', helm: 'dragoon', horses: [0, 1, 2, 3, 4] },
    // British light dragoons: dark blue jacket, buff facings, bell-topped shako with a white-over-red plume.
    gb_light: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#e6c86a', breech: '#8d8f9a', breechDk: '#6a6c77', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#f6f3ea', helm: 'shako', plume: ['#f6f3ea', '#c8191e'], curved: true, horses: [2, 0, 3, 2, 0] },
    // French light: chasseurs a cheval. Green coat, red facings, shako with a tall red plume.
    fr_light: { coat: '#1f5a32', coatDk: '#143c21', fac: '#d0202a', breech: '#1f5a32', breechDk: '#143c21', cloth: '#1f5a32', clothDk: '#143c21', lace: '#f6f3ea', helm: 'shako', plume: ['#d0202a', '#d0202a'], curved: true, horses: [0, 3, 2, 0, 3] },
    // French heavy: cuirassiers. Steel cuirass and helmet with a brass comb, black mane and red plume.
    fr_heavy: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#d0202a', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#f6f3ea', crest: '#151210', helm: 'cuirassier', cuirass: true, horses: [1, 0, 1, 3, 1] }
  };
  let R = SPECS.gb_heavy;

  function make(draw, dy = 0) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y + dy), w, h); };
    const ell = (cx, cy, rx, ry, col) => { for (let y = -ry; y <= ry; y++) { const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y / (ry + .5)) ** 2))); if (hw > 0) px(cx - hw, cy + y, col, hw * 2, 1); } };
    const line = (x0, y0, x1, y1, col, t = 3) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1); for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; px(Math.round(x - t / 2), Math.round(y - t / 2), col, t, t); } };
    draw({ px, ell, line, g }); return c;
  }

  /* ---------- the horse ---------- */
  // legs: each [hipX, hipY, hoofX, hoofY]; offsets per gait frame
  const GAIT = {
    stand:   [[0, 0], [0, 0], [0, 0], [0, 0]],
    stand2:  [[0, 0], [0, 0], [0, 0], [0, 0]],
    walk1:   [[2, 2], [0, 0], [-1, 0], [1, 1]],
    walk2:   [[1, 0], [-1, 2], [0, 1], [-1, 0]],
    walk3:   [[-1, 0], [2, 2], [1, 1], [0, 0]],
    walk4:   [[0, 1], [1, 0], [-1, 0], [1, 2]],
    gallop1: [[5, 4], [3, 3], [-4, 1], [-3, 1]],
    gallop2: [[3, 1], [1, 1], [-1, 3], [0, 2]],
    gallop3: [[-3, 1], [-4, 1], [4, 4], [3, 3]],
    gallop4: [[-1, 3], [0, 2], [2, 1], [1, 1]],
  };
  function horse(o, v, view, pose) {
    const [main, lite, dark, mane] = HORSE[R.horses[v % 5]];
    const gp = GAIT[pose] || GAIT.stand;
    const gal = pose.startsWith('gallop');
    const headDip = pose === 'stand2' ? 1 : gal ? (pose === 'gallop1' || pose === 'gallop3' ? -1 : 1) : 0;
    const legC = (far) => far ? dark : main;
    const leg = (hx, hy, fx, fy, dxy, far) => {
      const [dx, lift] = dxy; const tx = fx + dx, ty = fy - lift;
      const kx = (hx + tx) / 2 + (lift > 1 ? 1 : 0), ky = (hy + ty) / 2;
      o.line(hx, hy, kx, ky, legC(far), 4); o.line(kx, ky, tx, ty - 2, legC(far), 3);
      o.px(tx - 1, ty - 4, mane, 3, 2);   // dark lower leg (points)
      o.px(tx - 2, ty - 1, C.HOOF, 4, 2);
    };
    if (view === 'toward') {
      // heading down-right: haunch behind at upper-left, chest in front at lower-right
      leg(21, 40, 18, 58, gp[2], true); leg(38, 46, 39, 62, gp[1], true);   // far hind, far fore
      o.line(14, 33, 11, 46, mane, 3); o.line(12, 40, 10, 49, mane, 2);     // tail
      o.ell(22, 36, 9, 8, main); o.ell(21, 34, 6, 5, lite);                 // haunch
      o.ell(30, 40, 11, 8, main); o.px(22, 35, lite, 12, 2);                // barrel
      o.ell(39, 42, 8, 9, main); o.ell(37, 40, 5, 5, lite); o.px(44, 44, dark, 3, 6); // chest
      leg(25, 42, 24, 58, gp[3], false); leg(35, 47, 34, 63, gp[0], false); // near hind, near fore
      // neck and head: the head comes towards you, lower and bigger
      o.line(38, 37, 45, 28 + headDip, main, 8); o.line(36, 34, 42, 24 + headDip, mane, 2); o.line(37, 33, 43, 23 + headDip, mane, 1);
      o.ell(47, 31 + headDip, 4, 6, main); o.ell(46, 29 + headDip, 2, 3, lite);
      o.px(45, 35 + headDip, dark, 5, 3); o.px(46, 37 + headDip, '#161210', 1, 1); o.px(48, 37 + headDip, '#161210', 1, 1); // muzzle and nostrils
      o.px(44, 22 + headDip, main, 2, 4); o.px(49, 22 + headDip, dark, 2, 4);       // ears
      o.px(45, 28 + headDip, '#100c0a', 1, 1); o.px(49, 28 + headDip, '#100c0a', 1, 1); // eyes
      o.px(46, 25 + headDip, '#e8e2d4', 2, 2);                                     // a blaze on the forehead
      o.px(43, 33 + headDip, C.TACK, 9, 1); o.px(43, 26 + headDip, C.TACK, 1, 8); o.px(51, 26 + headDip, C.TACK, 1, 8); o.line(44, 34 + headDip, 33, 30, C.TACK, 1); // bridle, rein
    } else {
      // heading up-left, seen from behind: rump big and near at lower-right, head small and far at upper-left
      leg(22, 38, 20, 55, gp[1], true); leg(37, 44, 40, 60, gp[2], true);
      o.ell(23, 36, 7, 7, main);                                            // chest, far
      o.line(22, 33, 14, 26 + headDip, main, 7); o.line(24, 31, 17, 23 + headDip, mane, 2); // neck and mane
      o.ell(12, 25 + headDip, 3, 4, main); o.px(10, 20 + headDip, main, 2, 3); o.px(13, 20 + headDip, dark, 2, 3); // head, ears
      o.ell(30, 39, 11, 8, main); o.px(22, 34, lite, 14, 2);                // barrel
      leg(26, 42, 24, 58, gp[0], false); leg(40, 46, 43, 63, gp[3], false);
      o.ell(38, 41, 9, 9, main); o.ell(36, 38, 6, 5, lite); o.px(37, 33, dark, 2, 14); // rump with the dock line
      o.line(38, 36, 40, 52, mane, 4); o.line(39, 44, 41, 54, mane, 3);     // tail hanging behind
    }
  }

  /* ---------- headgear ---------- */
  function headgear(p, back) {
    if (R.helm === 'dragoon') {
      p(1, 1, C.B, 10, 5); p(9, 1, C.b, 2, 5);
      if (!back) { p(0, 5, C.B, 12, 1); p(1, 6, C.b, 10, 1); p(4, 2, '#fff2b0', 2, 2); p(3, -3, R.crest, 6, 4); p(2, -1, R.crest, 2, 3); p(8, -2, '#2a2420', 2, 3); }
      else { p(1, 5, C.b, 10, 1); p(3, -3, R.crest, 6, 4); p(5, 1, R.crest, 2, 5); }
    } else if (R.helm === 'cuirassier') {
      // steel skull, brass comb, black horsehair mane down the back, red plume on the left
      p(1, 1, '#c9ced6', 10, 5); p(8, 1, '#8a9098', 3, 5); p(2, 1, '#eef1f5', 2, 3);
      p(4, -3, C.B, 4, 4); p(5, -4, C.b, 2, 1);
      if (!back) { p(0, 5, '#b08a3c', 12, 1); p(1, 6, C.D, 10, 1); p(-1, 2, '#d0202a', 2, 6); p(7, -2, R.crest, 2, 3); }
      else { p(4, 0, R.crest, 4, 10); p(3, 2, R.crest, 6, 6); p(11, 2, '#d0202a', 2, 6); }
    } else {
      // bell-topped shako with a plume
      p(1, 1, '#1f1f1f', 10, 5); p(0, 0, '#1f1f1f', 12, 1); p(9, 1, '#3c3c3c', 2, 5);
      if (!back) { p(4, 2, C.B, 3, 2); p(1, 5, C.D, 10, 1); p(0, 6, C.D, 12, 1); }
      const px0 = back ? 2 : 8;
      p(px0, -6, R.plume[0], 2, 4); p(px0, -2, R.plume[1], 2, 2);
    }
  }

  /* ---------- the dragoon ---------- */
  function rider(o, v, view, pose) {
    const [s, sd] = SK[v % 5], [h, hd] = HR[v % 5];
    const back = view === 'away';
    const bx = back ? 25 : 24, by = 7;                                    // rider's local origin (top of helmet crest)
    const p = (x, y, c, w, hh) => o.px(bx + x, by + y, c, w, hh);
    // shabraque (saddle cloth) and the near leg
    if (!back) { o.px(22, 33, R.cloth, 13, 9); o.px(22, 41, R.lace, 13, 1); o.px(22, 33, R.clothDk, 2, 9); o.px(30, 30, '#2a2a2e', 6, 3); } // cloth, rolled cloak
    else { o.px(25, 33, R.cloth, 13, 9); o.px(25, 41, R.lace, 13, 1); o.px(36, 33, R.clothDk, 2, 9); o.px(27, 30, '#2a2a2e', 9, 3); }
    // near leg: breeches then jackboot down the flank
    const lx = back ? 34 : 24;
    o.px(lx, 31, R.breech, 4, 6); o.px(lx + 3, 31, R.breechDk, 1, 6); o.px(lx - 1, 37, C.D, 5, 9); o.px(lx - 1, 37, C.d, 1, 9); o.px(lx - 1, 45, C.D, 6, 2);
    // body
    p(0, 14, R.coat, 12, 10); p(10, 14, R.coatDk, 2, 10); p(-2, 14, R.coat, 3, 2); p(11, 14, R.coatDk, 3, 2);
    if (!back) {
      p(3, 14, R.fac, 6, 1); p(4, 13, C.D, 4, 1);                          // collar, stock
      for (let i = 0; i < 9; i++) p(1 + i, 15 + i, C.W, 2, 1);            // crossbelt over the left shoulder
      p(0, 22, C.W, 12, 2); p(5, 22, C.B, 2, 2);                           // waist belt and buckle
      for (let i = 0; i < 3; i++) p(6, 16 + i * 2, C.B, 1, 1);
      if (R.helm === 'shako') { p(2, 15, R.fac, 1, 7); p(9, 15, R.fac, 1, 7); }   // facing-coloured plastron edges
      if (R.cuirass) { p(0, 15, '#c9ced6', 12, 8); p(8, 15, '#8a9098', 4, 8); p(1, 15, '#eef1f5', 2, 6); p(0, 15, '#b08a3c', 12, 1); p(1, 17, C.B, 1, 1); p(10, 17, C.B, 1, 1); p(0, 22, C.W, 12, 2); } // breastplate
    } else {
      p(3, 14, R.fac, 6, 1); for (let i = 0; i < 9; i++) p(10 - i, 15 + i, C.W, 2, 1); p(0, 22, C.W, 12, 2);
      p(2, 24, R.coat, 3, 3); p(7, 24, R.coatDk, 3, 3);                     // coat skirts over the saddle
      if (R.cuirass) { p(0, 15, '#b9bec6', 12, 8); p(8, 15, '#80868e', 4, 8); p(0, 15, '#b08a3c', 12, 1); p(0, 22, C.W, 12, 2); } // backplate
    }
    // head and helmet (brass dragoon helmet with a black horsehair crest)
    if (!back) {
      p(2, 6, s, 8, 7); p(8, 6, sd, 2, 7); p(1, 8, s, 1, 2); p(10, 8, sd, 1, 2);
      p(3, 7, hd, 2, 1); p(7, 7, hd, 2, 1); p(4, 8, C.E, 1, 1); p(7, 8, C.E, 1, 1); p(5, 9, sd, 2, 2);
      const shout = pose.startsWith('gallop') || pose.startsWith('slash');
      if (v === 2 || v === 4) p(4, 11, h, 4, 1);
      if (shout) p(5, 12, C.MO, 2, 1); else p(5, 12, C.M, 2, 1);
      p(1, 6, h, 1, 2); p(10, 6, hd, 1, 2);
      headgear(p, false);
    } else {
      p(2, 6, h, 8, 5); p(8, 6, hd, 2, 5); p(3, 11, s, 6, 2); p(1, 8, s, 1, 2); p(10, 8, sd, 1, 2);
      headgear(p, true);
    }
    // arms and sabre
    const sab = (x0, y0, x1, y1) => {
      if (R.curved) { const mx = x0 + (x1 - x0) * .65, my = y0 + (y1 - y0) * .65, k = (y1 - y0) > 0 ? 1 : -1; o.line(bx + x0, by + y0, bx + mx, by + my, C.I, 2); o.line(bx + mx, by + my, bx + x1 + k, by + y1 + k, C.I, 2); }
      else o.line(bx + x0, by + y0, bx + x1, by + y1, C.I, 2);
      o.px(bx + x1, by + y1, '#ffffff', 1, 1); o.px(bx + x0 - 1, by + y0 - 1, C.B, 3, 2); };
    const RA = back ? -2 : 12, LA = back ? 12 : -2;                      // RA: sword arm side
    if (pose.startsWith('gallop')) {
      // charge: sabre held out at the point, arm extended
      p(RA, 15, R.coat, 3, 4); p(RA + (back ? -1 : 1), 19, s, 2, 2);
      if (!back) sab(14, 20, 24, 30); else sab(-3, 19, -12, 6);
      p(LA, 16, R.coat, 2, 6); p(LA, 22, s, 2, 2);
    } else if (pose === 'slash1') {
      p(RA, 8, R.coat, 3, 7); p(RA, 6, s, 2, 2); sab(RA + 1, 6, RA + (back ? -6 : 8), -6);
      p(LA, 16, R.coat, 2, 6); p(LA, 22, s, 2, 2);
    } else if (pose === 'slash2') {
      p(RA, 15, R.coat, 3, 5); p(RA + (back ? -1 : 1), 20, s, 2, 2); sab(RA + 1, 21, RA + (back ? -10 : 12), 32);
      p(LA, 16, R.coat, 2, 6); p(LA, 22, s, 2, 2);
    } else {
      // at rest: sabre sloped on the shoulder, reins in the left hand
      p(RA, 16, R.coat, 2, 6); p(RA, 22, s, 2, 2); sab(RA + 1, 22, RA + (back ? 2 : 0), 4);
      p(LA, 16, R.coat, 2, 6); p(LA, 22, s, 2, 2);
    }
  }

  function figure(view, pose, v) {
    const gal = pose.startsWith('gallop');
    const bob = gal ? ({ gallop1: 0, gallop2: -2, gallop3: -1, gallop4: 1 }[pose]) : pose.startsWith('walk') ? (pose === 'walk2' || pose === 'walk4' ? -1 : 0) : 0;
    const hp = gal ? pose : pose.startsWith('slash') ? 'stand' : pose;
    return make((o) => { horse(o, v, view, hp); rider(o, v, view, pose); }, bob);
  }
  function fallen(view, v, k) {
    // k 0: horse stumbles, 1: down on its knees, 2: lying with the rider thrown
    const [main, lite, dark, mane] = HORSE[R.horses[v % 5]];
    const [s] = SK[v % 5];
    if (k < 2) {
      const src = figure(view, 'stand', v);
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
      if (k === 0) { g.translate(W / 2, H); g.rotate(view === 'toward' ? 0.18 : -0.18); g.drawImage(src, -W / 2, -H); }
      else g.drawImage(src, 0, 0, W, H - 10, 0, 10, W, H - 10);
      return c;
    }
    return make((o) => {
      o.ell(30, 52, 16, 7, main); o.ell(28, 50, 11, 4, lite);                  // horse on its side
      o.line(44, 52, 54, 48, main, 5); o.ell(56, 48, 4, 3, main); o.px(57, 49, dark, 3, 2);
      o.line(16, 54, 6, 50, mane, 3);                                           // tail
      o.line(20, 57, 14, 62, dark, 3); o.line(26, 58, 24, 63, dark, 3); o.line(36, 58, 40, 63, dark, 3); o.line(40, 57, 46, 62, dark, 3);
      o.px(22, 47, R.cloth, 12, 3); o.px(22, 49, R.lace, 12, 1);
      // the rider thrown clear in front
      o.px(30, 58, R.coat, 12, 5); o.px(42, 59, s, 4, 4); o.px(40, 56, R.helm === 'dragoon' ? C.B : R.helm === 'cuirassier' ? '#c9ced6' : '#1f1f1f', 5, 3); o.px(24, 58, R.breech, 6, 4); o.px(19, 59, C.D, 5, 3);
      o.line(44, 62, 56, 60, C.I, 1);
      o.g.globalAlpha = .6; o.px(32, 63, '#6e1a14', 6, 1);
    });
  }

  const cache = new Map();
  function get(nation, view, pose, v, type = 'heavy') {
    const vv = view === 'away' ? 'away' : 'toward';
    const sk = (nation === 'french' ? 'fr_' : 'gb_') + type;
    const key = `${sk}:${vv}:${pose}:${v}`; let c = cache.get(key); if (c) return c;
    R = SPECS[sk];
    if (pose === 'hit') c = fallen(vv, v, 0); else if (pose === 'kneel') c = fallen(vv, v, 1); else if (pose === 'down') c = fallen(vv, v, 2);
    else if (pose.startsWith('run')) c = figure(vv === 'toward' ? 'away' : 'toward', 'gallop' + (pose === 'run1' ? '1' : '3'), v);
    else c = figure(vv, pose, v);
    cache.set(key, c); return c;
  }
  const ANIMS = {
    idle:   { frames: ['stand', 'stand', 'stand2', 'stand'], fps: 2, loop: true },
    march:  { frames: ['walk1', 'walk2', 'walk3', 'walk4'], fps: 6, loop: true },
    charge: { frames: ['gallop1', 'gallop2', 'gallop3', 'gallop4'], fps: 10, loop: true },
    melee:  { frames: ['slash1', 'slash2', 'stand', 'slash1', 'slash2', 'stand2'], fps: 7, loop: true },
    fall:   { frames: ['hit', 'kneel', 'down'], fps: 4, loop: false },
    flee:   { frames: ['gallop1', 'gallop2', 'gallop3', 'gallop4'].map(p => p), fps: 10, loop: true, turn: true }
  };
  const POSES = ['stand', 'stand2', 'walk1', 'walk2', 'walk3', 'walk4', 'gallop1', 'gallop2', 'gallop3', 'gallop4', 'slash1', 'slash2', 'hit', 'kneel', 'down'];
  return { get, ANIMS, POSES, W, H };
})();
