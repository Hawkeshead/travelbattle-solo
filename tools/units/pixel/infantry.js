/* Grognards pixel figures: line infantry, both nations. About 40 px tall.
   Canvas 48 x 56, feet at bottom centre (x 24, y 55); headroom for bearskins, plumes and smoke. Figure drawn in local coords x 0..23 (centre 12), offset by OX/OY.
   Views: toward (front), away (back), right (profile); left = mirror of right.
   Poses: stand walk1 walk2 present fire smoke reload1 reload2 charge lunge run1 run2 hit kneel down */
const GROG = (() => {
  const W = 48, H = 56, OX = 12, OY = 10;
  const SK = [['#ecc39c', '#c99a72'], ['#dca97c', '#b8865c'], ['#f2d2ae', '#d2ad86'], ['#d49b70', '#ad774e'], ['#e6b88f', '#c39168']];
  const HR = [['#6a4426', '#4a2e18'], ['#d6b25a', '#a8863a'], ['#2c241c', '#18120c'], ['#b4532a', '#86391a'], ['#4a3020', '#2e1c12']];
  const C = { K: '#1f1f1f', k: '#3c3c3c', B: '#e6b422', b: '#a87a12', W: '#f6f3ea', w: '#cfcabd', D: '#1d1a17', d: '#3d3832', g: '#4a443c',
    T: '#7a5030', t: '#553820', I: '#d8dce2', i: '#8a8f98', E: '#24160c', M: '#a0524a', MO: '#5a1e18', F: ['#fff6c0', '#ffd23a', '#ff8a1a'], RED: '#d0202a', REDK: '#931218' };
  const NAT = {
    british: { coat: '#c8191e', coatDk: '#8f1014', coatHi: '#e2443d', fac: '#f3e7a0', tr: '#8d8f9a', trDk: '#6a6c77', pack: '#24201c', packDk: '#110f0d' },
    french:  { coat: '#21409f', coatDk: '#142a6e', coatHi: '#3a5cc4', fac: '#d0202a', tr: '#f6f3ea', trDk: '#cfcabd', pack: '#a06c3a', packDk: '#72481f' }
  };
  const NATG = {
    // British Guard: a deeper red, Guards blue facings, Highland kilts
    british: { ...NAT.british, coat: '#a8121a', coatDk: '#740c10', coatHi: '#c42a30', fac: '#203a8a', kilt: true },
    // French Old Guard: navy coats and trousers, red grenadier epaulettes, gold earrings and medals for the veterans
    french:  { ...NAT.french, coat: '#16245e', coatDk: '#0d1640', coatHi: '#283a8a', tr: '#1f2f72', trDk: '#141f50', epaulette: '#d0202a', gold: true }
  };
  const NATA = {
    // Royal Artillery: dark blue coat, red facings, grey trousers. French foot artillery: dark blue with red facings and epaulettes, blue trousers.
    british: { ...NAT.british, coat: '#1c2a5a', coatDk: '#121b3c', coatHi: '#2c3e7a', fac: '#c8191e', gunner: true },
    french:  { ...NAT.french, coat: '#1c2a5a', coatDk: '#121b3c', coatHi: '#2c3e7a', fac: '#d0202a', tr: '#1c2a5a', trDk: '#121b3c', epaulette: '#d0202a', gunner: true }
  };
  const TARTAN = ['#1f3b2a', '#1d2a4f', '#0e1410'];
  const tartan = (x, y) => (x % 4 === 0 || y % 4 === 3) ? TARTAN[2] : (((x >> 1) + (y >> 1)) % 2 ? TARTAN[0] : TARTAN[1]);
  const FLAGC = { blue: '#1f3a8a', red: '#c8191e', white: '#f6f3ea', fblue: '#21409f', fred: '#d0202a', gold: '#e6b422' };
  const SMOKE = ['rgba(232,232,226,.92)', 'rgba(210,210,204,.85)', 'rgba(245,245,240,.7)', 'rgba(190,190,186,.6)'];

  function canvas(w = W, h = H) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const BIG = { W: 64, H: 80, OX: 20, OY: 34 };   // colour bearer: room for the pole and flag
  function make(draw, dy = 0, dims) {
    const D = dims || { W, H, OX, OY };
    const c = canvas(D.W, D.H), g = c.getContext('2d');
    const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(x + D.OX, y + D.OY + dy, w, h); };
    draw(px, g); return c;
  }
  function mirror(src) { const c = canvas(), g = c.getContext('2d'); g.translate(W, 0); g.scale(-1, 1); g.drawImage(src, 0, 0); return c; }
  function smoke(px, x, y, big) {
    px(x + 2, y, SMOKE[0], 5, 3); px(x, y + 2, SMOKE[1], 4, 3); px(x + 5, y + 2, SMOKE[2], 5, 3); px(x + 3, y + 4, SMOKE[0], 5, 3); px(x + 8, y, SMOKE[3], 3, 2);
    if (big) { px(x - 2, y - 2, SMOKE[2], 4, 3); px(x + 9, y + 4, SMOKE[1], 4, 3); px(x + 4, y - 3, SMOKE[3], 4, 2); }
  }
  function flash(px, x, y) { px(x - 2, y - 2, C.F[1], 5, 5); px(x - 1, y - 1, C.F[0], 3, 3); px(x - 3, y, C.F[2], 1, 1); px(x + 3, y, C.F[2], 1, 1); px(x, y - 3, C.F[2], 1, 1); }

  /* ================= front and back ================= */
  function legsFB(px, N, pose, back) {
    if (N.kilt) return kiltFB(px, pose, back);
    let L = [7, 13], lift = [0, 0];
    if (pose === 'walk1') lift = [2, 0];
    if (pose === 'walk2') lift = [0, 2];
    if (pose === 'run1') lift = [3, 0];
    if (pose === 'run2') lift = [0, 3];
    if (['present', 'fire', 'smoke', 'charge', 'lunge'].includes(pose)) L = [6, 14];
    L.forEach((x, i) => {
      const l = lift[i];
      px(x, 31, N.tr, 4, 7 - l); px(x + 3, 31, N.trDk, 1, 7 - l);
      px(x, 38 - l, C.D, 4, 4); px(x, 38 - l, C.d, 1, 4); px(x + 3, 39 - l, C.g, 1, 1); px(x + 3, 41 - l, C.g, 1, 1);
      px(x - 1, 42 - l, C.D, 5, 2);
    });
    px(11, 31, N.trDk, 2, 3);
  }
  function shakoFB(px, nation, back) {
    if (nation === 'british') {
      px(7, 6, C.K, 10, 6); px(8, 5, C.K, 8, 1); px(9, 4, C.K, 6, 1); px(15, 6, C.k, 2, 6);
      if (!back) { px(10, 6, C.B, 4, 3); px(11, 9, C.B, 2, 1); px(11, 5, C.B, 2, 1); px(13, 6, C.b, 1, 3); px(8, 10, C.w, 2, 1); px(10, 11, C.w, 4, 1); px(14, 10, C.w, 2, 1); px(6, 12, C.D, 12, 1); px(7, 13, C.D, 10, 1); }
      else { px(8, 10, C.w, 8, 1); px(7, 12, C.k, 10, 1); }
      const p = back ? 7 : 16;
      px(p, 0, C.W, 2, 3); px(p + 1, 0, C.w, 1, 3); px(p, 3, C.RED, 2, 3); px(p + 1, 3, C.REDK, 1, 3);
    } else {
      px(8, 6, C.K, 8, 6); px(7, 5, C.K, 10, 1); px(6, 4, C.K, 12, 1); px(15, 5, C.k, 2, 7);
      if (!back) { px(11, 6, C.B, 2, 1); px(10, 7, C.B, 4, 1); px(11, 8, C.B, 2, 1); px(13, 7, C.b, 1, 1); px(8, 10, C.RED, 8, 1); px(6, 12, C.D, 12, 1); px(7, 13, C.D, 10, 1); px(7, 13, C.B, 1, 5); px(16, 13, C.B, 1, 5); }
      else { px(8, 10, C.RED, 8, 1); px(8, 12, C.k, 8, 1); }
      px(11, 1, C.RED, 2, 3); px(10, 2, C.RED, 4, 2); px(13, 2, C.REDK, 1, 2);
    }
  }
  function kiltFB(px, pose, back) {
    let L = [7, 13], lift = [0, 0];
    if (pose === 'walk1') lift = [2, 0];
    if (pose === 'walk2') lift = [0, 2];
    if (pose === 'run1') lift = [3, 0];
    if (pose === 'run2') lift = [0, 3];
    if (['present', 'fire', 'smoke', 'charge', 'lunge'].includes(pose)) L = [6, 14];
    L.forEach((x, i) => {
      const l = lift[i];
      px(x, 37 - l, '#e2b48c', 4, 1);                                              // bare knee
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) px(x + c, 38 + r - l, (r + c) % 2 ? '#c8191e' : '#f6f3ea', 1, 1); // diced hose
      px(x, 41 - l, '#f6f3ea', 4, 1); px(x + 3, 41 - l, '#cfcabd', 1, 1);         // white spats
      px(x - 1, 42 - l, C.D, 5, 2);
    });
    // the kilt, with pleats behind and a sporran in front
    for (let y = 31; y < 37; y++) for (let x = 5; x < 19; x++) px(x, y, tartan(x, y), 1, 1);
    if (back) { for (let x = 6; x < 18; x += 2) px(x, 32, TARTAN[2], 1, 5); }
    else { px(10, 31, '#f6f3ea', 4, 4); px(10, 31, '#1d1a17', 4, 1); px(10, 35, '#1d1a17', 1, 1); px(12, 35, '#1d1a17', 1, 1); }
  }
  function bearskinFB(px, nation, back) {
    // tall black bearskin with a fur texture
    px(7, 2, C.K, 10, 11); px(8, -1, C.K, 8, 3); px(9, -3, C.K, 6, 2); px(15, 0, C.k, 2, 12);
    for (const [x, y] of [[9, 1], [12, 3], [10, 6], [14, 5], [8, 8], [13, 9], [11, 0]]) px(x, y, C.k, 1, 1);
    if (!back) { px(6, 12, C.D, 12, 1); if (nation === 'british') { px(7, 13, C.B, 1, 5); px(16, 13, C.B, 1, 5); } }
    if (nation === 'french') {
      if (!back) { px(10, 8, C.B, 4, 4); px(11, 7, C.B, 2, 1); px(13, 8, C.b, 1, 4); px(8, 10, C.RED, 8, 1); px(9, 11, C.RED, 1, 2); }
      else { px(10, 0, C.RED, 4, 4); px(11, 1, C.W, 2, 2); }      // red patch with a white grenade on the crown
      const p = back ? 6 : 17; px(p, -5, C.RED, 2, 9); px(p + 1, -5, C.REDK, 1, 9);
    } else {
      const p = back ? 6 : 17; px(p, -2, C.W, 2, 7); px(p + 1, -2, C.w, 1, 7);
    }
  }
  function bearskinSide(px, nation) {
    px(9, 2, C.K, 9, 11); px(10, -1, C.K, 7, 3); px(11, -3, C.K, 5, 2); px(9, 2, C.k, 1, 10);
    for (const [x, y] of [[12, 1], [14, 4], [11, 7], [15, 9]]) px(x, y, C.k, 1, 1);
    if (nation === 'british') px(12, 13, C.B, 1, 5);
    if (nation === 'french') { px(17, 7, C.B, 1, 3); px(9, -5, C.RED, 2, 9); px(10, 10, C.RED, 7, 1); }
    else px(9, -2, C.W, 2, 7);
  }
  function flag(px, nation, x0, y0, fp) {
    // a flag flying to the right of the pole, waving: fp is the wave phase 0..5
    const w = 18, h = 12, cx = 8.5, cy = 5.5;
    for (let c = 0; c < w; c++) {
      const a = fp / 6 * Math.PI * 2 - c * 0.42, amp = 2.2 * (c / (w - 1));
      const dy = Math.round(Math.sin(a) * amp), dark = Math.cos(a) * amp < -0.6;
      for (let r = 0; r < h; r++) {
        let col;
        if (nation === 'british') {
          const d1 = Math.abs((r - cy) - (c - cx) * h / w), d2 = Math.abs((r - cy) + (c - cx) * h / w);
          col = FLAGC.blue;
          if (d1 < 1.7 || d2 < 1.7) col = FLAGC.white;
          if (d1 < 0.6 || d2 < 0.6) col = FLAGC.red;
          if (Math.abs(c - cx) < 2.6 || Math.abs(r - cy) < 2.3) col = FLAGC.white;
          if (Math.abs(c - cx) < 1.4 || Math.abs(r - cy) < 1.2) col = FLAGC.red;
        } else {
          col = c < 6 ? FLAGC.fblue : c < 12 ? FLAGC.white : FLAGC.fred;
          if (r === 0 || r === h - 1) col = FLAGC.gold;
        }
        if (c === w - 1) col = FLAGC.gold;                        // fringe on the fly
        px(x0 + c, y0 + r + dy, dark ? shadeHex(col) : col, 1, 1);
      }
    }
  }
  function shadeHex(hex) { const n = parseInt(hex.slice(1), 16); const f = v => Math.round(v * 0.72); return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`; }
  function faceFB(px, v, tache, shout, look, style, gold) {
    const [s, sd] = SK[v % 5], [h, hd] = HR[v % 5];
    px(8, 13, s, 8, 7); px(14, 13, sd, 2, 7); px(9, 20, s, 6, 1); px(13, 20, sd, 2, 1);
    px(7, 15, s, 1, 2); px(16, 15, sd, 1, 2);
    px(8, 13, h, 1, 3); px(15, 13, hd, 1, 3);
    px(9, 14, hd, 2, 1); px(13, 14, hd, 2, 1);
    px(10 + (look || 0), 15, C.E, 1, 1); px(13 + (look || 0), 15, C.E, 1, 1);
    px(11, 16, sd, 2, 2);
    let mouth = true;
    if (style >= 0) {
      // Guard moustaches: handlebar, walrus, chevron, mutton chops, imperial
      if (style === 0) { px(9, 18, h, 6, 1); px(8, 17, hd, 1, 1); px(15, 17, hd, 1, 1); }
      if (style === 1) { px(9, 18, h, 6, 1); px(10, 19, hd, 4, 1); mouth = shout; }
      if (style === 2) { px(10, 18, h, 4, 1); }
      if (style === 3) { px(8, 13, h, 1, 7); px(15, 13, hd, 1, 7); px(9, 18, h, 6, 1); px(9, 19, hd, 1, 1); px(14, 19, hd, 1, 1); }
      if (style === 4) { px(9, 18, h, 6, 1); px(11, 20, hd, 2, 1); }
    } else if (tache) { px(10, 18, h, 4, 1); px(9, 18, hd, 1, 1); px(14, 18, hd, 1, 1); }
    if (mouth) { if (shout) px(11, 19, C.MO, 2, 2); else px(11, 19, C.M, 2, 1); }
    if (gold) { px(7, 17, C.B, 1, 1); px(16, 17, C.B, 1, 1); }                           // gold earrings
  }
  function headBack(px, v) {
    const [s, sd] = SK[v % 5], [h, hd] = HR[v % 5];
    px(8, 13, h, 8, 5); px(14, 13, hd, 2, 5); px(9, 18, h, 6, 1);
    px(7, 15, s, 1, 2); px(16, 15, sd, 1, 2); px(10, 19, s, 4, 2); px(13, 19, sd, 1, 2);
  }
  function torsoFront(px, N, nation) {
    px(6, 21, N.coat, 12, 10); px(16, 21, N.coatDk, 2, 10); px(6, 21, N.coatHi, 1, 9);
    px(4, 21, N.coat, 3, 2); px(17, 21, N.coatDk, 3, 2);
    if (N.gunner) {
      px(9, 21, N.fac, 6, 1); px(10, 20, C.D, 4, 1);
      for (let i = 0; i < 4; i++) px(11, 23 + i * 2, C.B, 2, 1);
      for (let i = 0; i < 9; i++) px(7 + i, 22 + i, C.W, 2, 1);
      if (nation === 'british') { px(6, 22, N.fac, 1, 8); px(17, 22, N.fac, 1, 8); }
    } else if (nation === 'british') {
      px(4, 21, C.w, 1, 2); px(19, 21, C.w, 1, 2);
      px(9, 21, N.fac, 6, 1); px(10, 20, C.D, 4, 1);
      for (let i = 0; i < 4; i++) { px(9, 23 + i * 2, C.W, 2, 1); px(13, 23 + i * 2, C.W, 2, 1); }
      for (let i = 0; i < 9; i++) { px(7 + i, 22 + i, C.W, 2, 1); px(15 - i, 22 + i, C.W, 2, 1); }
      px(11, 25, C.B, 2, 2); px(12, 26, C.b, 1, 1);
    } else {
      px(9, 21, N.fac, 6, 1); px(10, 20, C.D, 4, 1);
      px(9, 22, C.W, 6, 6); px(14, 22, C.w, 1, 6);
      for (let i = 0; i < 3; i++) { px(10, 23 + i * 2, C.B, 1, 1); px(13, 23 + i * 2, C.B, 1, 1); }
      px(7, 22, C.W, 2, 9); px(15, 22, C.W, 2, 9); px(11, 28, C.B, 2, 2);
    }
    if (N.epaulette) { px(3, 20, N.epaulette, 4, 2); px(17, 20, N.epaulette, 4, 2); px(3, 22, N.epaulette, 1, 1); px(5, 22, N.epaulette, 1, 1); px(18, 22, N.epaulette, 1, 1); px(20, 22, N.epaulette, 1, 1); }
    if (N.gold && MEDAL) { px(14, 23, C.RED, 2, 1); px(14, 24, C.B, 2, 2); px(15, 25, C.b, 1, 1); if (MEDAL > 1) { px(9, 23, C.RED, 1, 1); px(9, 24, C.B, 1, 2); } } // Legion d'honneur and a second medal
    px(5, 31, N.coat, 2, 3); px(17, 31, N.coatDk, 2, 3); px(5, 33, C.W, 2, 1); px(17, 33, C.W, 2, 1);
  }
  function torsoBack(px, N, nation) {
    px(6, 21, N.coat, 12, 10); px(16, 21, N.coatDk, 2, 10);
    px(4, 21, N.coat, 3, 2); px(17, 21, N.coatDk, 3, 2);
    px(9, 21, N.fac, 6, 1);
    if (N.epaulette) { px(3, 20, N.epaulette, 4, 2); px(17, 20, N.epaulette, 4, 2); }
    if (N.gunner) { for (let i = 0; i < 9; i++) px(15 - i, 22 + i, C.W, 2, 1); px(7, 30, N.coat, 4, 4); px(13, 30, N.coatDk, 4, 4); px(7, 33, N.fac, 4, 1); px(13, 33, N.fac, 4, 1); px(11, 30, N.coatDk, 2, 4); return; }
    px(7, 22, N.pack, 10, 8); px(15, 22, N.packDk, 2, 8);
    px(6, 21, '#8a8c90', 12, 2); px(6, 22, '#6a6c70', 12, 1);
    px(6, 22, C.W, 1, 8); px(17, 22, C.W, 1, 8);
    if (nation === 'british') { px(11, 25, C.W, 2, 2); px(10, 26, C.w, 4, 1); px(10, 19, '#9a9ea4', 4, 2); }
    else { px(9, 23, '#e6d6b8', 2, 2); px(13, 25, '#e6d6b8', 2, 2); px(10, 28, '#e6d6b8', 2, 1); px(15, 23, '#c89a62', 1, 3); }
    px(7, 30, N.coat, 4, 4); px(13, 30, N.coatDk, 4, 4); px(7, 33, C.W, 4, 1); px(13, 33, C.W, 4, 1); px(11, 30, N.coatDk, 2, 4);
  }
  function musketV(px, x, top, bot, flip) {
    // upright musket: bayonet, barrel, stock; flip puts the shade on the other side
    px(x + (flip ? 0 : 1), top, C.I, 1, 6);
    px(x, top + 6, C.I, 2, 14); px(x + (flip ? 0 : 1), top + 6, C.i, 1, 14);
    px(x, top + 20, C.T, 2, bot - top - 20); px(x + (flip ? 0 : 1), top + 20, C.t, 1, bot - top - 20);
  }
  function armsFB(px, N, v, pose, back) {
    const [s, sd] = SK[v % 5];
    const L = back ? 19 : 4, R = back ? 4 : 19;   // L: the arm on his right (musket side)
    const sleeve = (x, y, h, dk) => { px(x, y, dk ? N.coatDk : N.coat, 2, h); px(x, y + h, N.fac, 2, 1); };
    switch (pose) {
      case 'stand': case 'walk1': case 'walk2': {
        const march = pose !== 'stand';
        const mx = back ? 21 : 2;
        if (march) { musketV(px, mx, -4, 30, back); px(L, 23, N.coat, 2, 5); px(L, 28, N.fac, 2, 1); px(mx, 27, s, 2, 2); } // shoulder arms
        else { musketV(px, mx, 0, 44, back); px(mx - (back ? 0 : 1), 39, C.T, 3, 5); sleeve(L, 23, 7); px(mx, 31, s, 2, 2); }
        const sw = pose === 'walk1' ? 1 : pose === 'walk2' ? -1 : 0;
        sleeve(R, 23 + sw, 8, !back); px(R, 32 + sw, s, 2, 2); px(R + 1, 32 + sw, sd, 1, 2);
        return;
      }
      case 'present': case 'fire': case 'smoke':
        if (back) {
          px(17, 21, N.coat, 4, 3); px(3, 21, N.coat, 4, 3); px(19, 24, N.coatDk, 2, 2);
          px(20, 2, C.I, 1, 6); px(19, 8, C.I, 2, 10); px(20, 8, C.i, 1, 10); px(19, 18, C.T, 2, 6);
          if (pose === 'fire') flash(px, 20, 0);
          if (pose === 'smoke') smoke(px, 14, -4, true);
        } else {
          px(4, 21, N.coat, 4, 4); px(16, 21, N.coatDk, 4, 3); px(8, 24, s, 2, 2); px(15, 22, s, 2, 2);
          px(9, 22, C.T, 7, 2); px(9, 22, C.t, 7, 1); px(10, 21, C.i, 3, 3); px(11, 22, '#111', 1, 1);
          if (pose === 'fire') { px(7, 18, C.F[1], 9, 8); px(9, 20, C.F[0], 5, 4); px(6, 21, C.F[2], 1, 2); px(16, 20, C.F[2], 1, 2); }
          if (pose === 'smoke') smoke(px, 4, 14, true);
        }
        return;
      case 'reload1': case 'reload2': {
        // musket upright in front of him, butt on the ground; ramrod going in (1) and drawn up (2)
        const mx = back ? 15 : 7;
        musketV(px, mx, 6, 44, back);
        const up = pose === 'reload2' ? 6 : 0;
        px(mx + (back ? 1 : 0), 2 - up, C.i, 1, 5 + up);
        const ha = back ? 15 : 7;
        px(back ? 17 : 5, 21, N.coat, 2, 2); px(ha, 1 - up, s, 2, 2);                // right hand on the rammer
        px(back ? 17 : 5, 21 - up, N.coat, 2, Math.max(1, 3 - up));
        sleeve(R, 23, 6); px(back ? 6 : 16, 29, s, 2, 2); px(back ? 8 : 14, 29, N.coat, 2, 1); // left hand steadies the barrel
        return;
      }
      case 'charge': case 'lunge': {
        // bayonet levelled: from the front it points down at you, from behind it reaches up past his shoulder
        const k = pose === 'lunge' ? 2 : 0;
        if (back) {
          px(18, 22, N.coat, 3, 6); px(4, 22, N.coat, 3, 5); px(18, 28, s, 2, 2);
          for (let i = 0; i < 10; i++) px(19 - Math.floor(i * 0.5), 29 - i * 2 - k, i < 4 ? C.T : C.I, 2, 2);
          px(14, 8 - k, '#fff', 1, 2);
        } else {
          px(16, 23, N.coatDk, 3, 6); px(4, 23, N.coat, 3, 5); px(16, 29, s, 2, 2); px(5, 28, s, 2, 2);
          for (let i = 0; i < 9; i++) px(17 - i, 29 + Math.floor(i / 2) + k, i < 4 ? C.T : C.I, 2, 1);
          px(8, 34 + k, '#fff', 1, 1);
        }
        return;
      }
      case 'run1': case 'run2': {
        const sw = pose === 'run1' ? 2 : -2;
        px(L, 22 - sw, N.coat, 2, 6); px(L, 28 - sw, s, 2, 2);
        px(R, 22 + sw, N.coat, 2, 6); px(R, 28 + sw, s, 2, 2);
        return;
      }
    }
  }
  const IDLE = { sway1: 1, sway2: -1, look: 0 };
  let MEDAL = 0;
  function figureFB(nation, view, pose, v, kind = 'line', fp = 0) {
    const N = kind === 'line' ? NAT[nation] : kind === 'gunner' ? NATA[nation] : NATG[nation], back = view === 'away';
    const tache = nation === 'french' ? v % 2 === 0 : v === 3;
    const bob = ['walk1', 'walk2'].includes(pose) ? -1 : ['run1', 'run2'].includes(pose) ? -2 : pose === 'lunge' ? 1 : 0;
    const sway = IDLE[pose] || 0, base = pose in IDLE ? 'stand' : pose;
    const bearer = kind === 'bearer';
    MEDAL = kind === 'line' || kind === 'gunner' ? 0 : [2, 1, 0, 1, 2][v % 5];
    return make((px0) => {
      const px = (x, y, c, w, h) => px0(x + (y < 31 ? sway : 0), y, c, w, h);
      legsFB(px0, N, bearer && !['walk1', 'walk2', 'run1', 'run2'].includes(base) ? 'stand' : base, back);
      if (back) { torsoBack(px, N, nation); headBack(px, v); } else { torsoFront(px, N, nation); faceFB(px, v, tache, ['charge', 'lunge', 'run1', 'run2'].includes(base), pose === 'look' ? (v % 2 ? 1 : -1) : 0, kind === 'line' || kind === 'gunner' ? -1 : v % 5, N.gold && v % 5 !== 2); }
      if (kind === 'line' || kind === 'gunner') shakoFB(px, nation, back); else bearskinFB(px, nation, back);
      if (bearer) bearerArms(px, N, v, base, back, nation, fp);
      else if (kind === 'gunner') gunnerArms(px, N, v, base, back);
      else armsFB(px, N, v, base, back);
    }, bob, bearer ? BIG : null);
  }
  function gunnerArms(px, N, v, pose, back) {
    const [s, sd] = SK[v % 5];
    const sleeve = (x, y, h) => { px(x, y, N.coat, 2, h); px(x, y + h, N.fac, 2, 1); };
    const RAM = '#6a4a2a', SPONGE = '#2a2420';
    if (pose === 'ears') { px(4, 17, N.coat, 3, 5); px(17, 17, N.coat, 3, 5); px(6, 15, s, 2, 3); px(16, 15, s, 2, 3); return; }   // hands over his ears
    if (pose === 'carry') { px(5, 22, N.coat, 3, 4); px(16, 22, N.coat, 3, 4); px(9, 24, '#1a1a1a', 6, 5); px(10, 25, '#4a4a4a', 2, 1); px(8, 26, s, 2, 2); px(14, 26, s, 2, 2); return; } // cannonball
    if (pose === 'ram1' || pose === 'ram2') {
      // the rammer: a long pole with a sponge head, driven forward towards the gun
      const k = pose === 'ram2' ? 4 : 0;
      if (back) { for (let i = 0; i < 16; i++) px(17 - Math.floor(i * 0.5), 32 - i * 2 - k, RAM, 2, 2); px(9, 0 - k, SPONGE, 4, 3); px(16, 24, s, 2, 2); px(18, 21, N.coat, 2, 4); px(4, 23, N.coat, 2, 6); px(4, 29, s, 2, 2); }
      else { for (let i = 0; i < 16; i++) px(4 + i, 18 + i + k, RAM, 2, 2); px(19, 33 + k, SPONGE, 4, 4); px(6, 22, s, 2, 2); px(4, 20, N.coat, 3, 3); px(14, 28, s, 2, 2); px(16, 23, N.coatDk, 2, 5); }
      return;
    }
    const sw = pose === 'walk1' || pose === 'run1' ? 1 : pose === 'walk2' || pose === 'run2' ? -1 : 0;
    sleeve(back ? 19 : 4, 23 - sw, 8); px(back ? 19 : 4, 32 - sw, s, 2, 2);
    sleeve(back ? 4 : 19, 23 + sw, 8); px(back ? 4 : 19, 32 + sw, s, 2, 2);
  }
  function bearerArms(px, N, v, pose, back, nation, fp) {
    // the colour bearer: no musket, both hands on the pole; the flag flies to the right
    const [s] = SK[v % 5];
    const pxl = back ? 3 : 20;                                     // pole x
    px(pxl, -26, '#3a2618', 1, 70); px(pxl + 1, -26, '#5a3a22', 1, 70);
    if (nation === 'french') { px(pxl - 2, -31, C.B, 6, 2); px(pxl - 3, -32, C.B, 2, 1); px(pxl + 3, -32, C.B, 2, 1); px(pxl, -33, C.B, 2, 2); px(pxl, -29, C.b, 2, 3); } // eagle
    else { px(pxl, -31, C.B, 2, 5); px(pxl - 1, -28, C.B, 4, 1); }                                                      // spear point
    flag(px, nation, pxl + 2, -25, fp);
    px(pxl + 2, -13, C.B, 1, 4); px(pxl + 2, -9, C.b, 2, 2);                                                            // cord and tassel
    const sw = pose === 'walk1' ? 1 : pose === 'walk2' ? -1 : 0;
    if (back) { px(2, 22, N.coat, 3, 3); px(3, 24, s, 2, 2); px(19, 23 + sw, N.coat, 2, 8); px(19, 31 + sw, N.fac, 2, 1); px(19, 32 + sw, s, 2, 2); }
    else { px(18, 22, N.coatDk, 3, 3); px(19, 24, s, 2, 2); px(18, 29, s, 2, 2); px(4, 23 + sw, N.coat, 2, 8); px(4, 31 + sw, N.fac, 2, 1); px(4, 32 + sw, s, 2, 2); }
  }

  /* ================= profile (facing right) ================= */
  function figureSide(nation, pose0, v, kind = 'line') {
    const pose = pose0 in IDLE ? 'stand' : pose0, sway = IDLE[pose0] || 0;
    const N = kind === 'line' ? NAT[nation] : NATG[nation], [s, sd] = SK[v % 5], [h, hd] = HR[v % 5];
    const tache = nation === 'french' ? v % 2 === 0 : v === 3;
    const bob = ['walk1', 'walk2'].includes(pose) ? -1 : ['run1', 'run2'].includes(pose) ? -2 : 0;
    const lean = ['charge', 'lunge', 'run1', 'run2'].includes(pose) ? 1 : 0;
    return make((px0) => {
      const px = (x, y, c, w, hh) => px0(x + (y < 31 ? lean * (y < 21 ? 2 : 1) + sway : 0), y, c, w, hh);
      // musket carried at the shoulder sits behind the body
      if (pose === 'walk1' || pose === 'walk2') { px(13, -2, C.I, 1, 6); px(12, 4, C.I, 2, 14); px(12, 18, C.T, 2, 12); }
      // legs: back leg darker
      const legs = { stand: [[10, 0], [12, 0]], walk1: [[8, -1], [14, 1]], walk2: [[14, -1], [8, 1]], present: [[8, 0], [14, 0]], fire: [[8, 0], [14, 0]], smoke: [[8, 0], [14, 0]],
        reload1: [[10, 0], [12, 0]], reload2: [[10, 0], [12, 0]], charge: [[7, 0], [15, 0]], lunge: [[6, 0], [17, 0]], run1: [[6, -2], [16, 2]], run2: [[16, -2], [6, 2]] }[pose] || [[10, 0], [12, 0]];
      legs.forEach(([x, sl], i) => {
        const dk = i === 0;
        const lift = Math.max(0, -sl);
        if (N.kilt) {
          px(x, 37 - lift, dk ? '#c09070' : '#e2b48c', 4, 1);
          for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) px(x + c, 38 + r - lift, (r + c) % 2 ? (dk ? '#951116' : '#c8191e') : (dk ? '#cfcabd' : '#f6f3ea'), 1, 1);
          px(x, 41 - lift, '#f6f3ea', 4, 1); px(x, 42 - lift, C.D, 6, 2);
          return;
        }
        px(x, 31, dk ? N.trDk : N.tr, 4, 7 - lift);
        px(x, 38 - lift, dk ? C.d : C.D, 4, 4); if (!dk) { px(x + 3, 39 - lift, C.g, 1, 1); px(x + 3, 41 - lift, C.g, 1, 1); }
        px(x, 42 - lift, C.D, 6, 2);
      });
      if (N.kilt) for (let y = 31; y < 37; y++) for (let x = 7; x < 18; x++) px0(x, y, tartan(x, y), 1, 1);
      // coat tails behind, knapsack and greatcoat roll
      px(7, 30, N.coat, 3, 5); px(7, 34, C.W, 3, 1);
      px(3, 22, N.pack, 6, 9); px(3, 22, N.packDk, 1, 9); px(3, 20, '#8a8c90', 7, 2); px(3, 21, '#6a6c70', 7, 1);
      // torso
      px(9, 21, N.coat, 8, 10); px(9, 21, N.coatDk, 2, 10); px(16, 22, N.coatHi, 1, 8);
      px(11, 21, N.fac, 5, 1); px(12, 20, C.D, 4, 1);
      if (nation === 'british') { for (let i = 0; i < 8; i++) px(15 - Math.floor(i * 0.6), 22 + i, C.W, 2, 1); px(15, 24, C.W, 2, 1); px(15, 26, C.W, 2, 1); px(15, 28, C.W, 2, 1); }
      else { px(15, 22, C.W, 2, 6); px(16, 23, C.B, 1, 1); px(16, 25, C.B, 1, 1); px(10, 22, C.W, 2, 9); }
      px(8, 30, C.D, 3, 3); // cartridge box at the back hip
      // head, facing right
      px(10, 13, s, 7, 7); px(17, 15, s, 1, 2); px(11, 20, s, 5, 1);
      px(9, 13, h, 3, 6); px(10, 19, hd, 2, 1); px(12, 13, h, 1, 3);    // back hair, sideburn
      px(12, 15, sd, 1, 2);                                          // ear
      px(15, 15, C.E, 1, 1); px(14, 14, hd, 2, 1);                   // eye, brow
      const st = kind === 'line' ? -1 : v % 5;
      if (st >= 0) {
        px(15, 18, h, 2, 1);
        if (st === 0) px(17, 17, hd, 1, 1);
        if (st === 1) px(15, 19, hd, 2, 1);
        if (st === 3) px(12, 13, h, 1, 7);
        if (st === 4) px(16, 20, hd, 1, 1);
        if (N.gold && v % 5 !== 2) px(12, 17, C.B, 1, 1);
      } else if (tache) px(15, 18, h, 2, 1);
      if (!(st === 1 && !['charge', 'lunge', 'run1', 'run2'].includes(pose))) { if (['charge', 'lunge', 'run1', 'run2'].includes(pose)) px(15, 19, C.MO, 2, 1); else px(15, 19, C.M, 2, 1); }
      // headgear
      if (kind !== 'line') bearskinSide(px, nation);
      else if (nation === 'british') {
        px(9, 6, C.K, 8, 6); px(13, 4, C.K, 4, 2); px(9, 6, C.k, 1, 6); px(15, 5, C.B, 2, 3); px(16, 9, C.w, 1, 2);
        px(14, 12, C.D, 5, 1); px(10, 12, C.D, 4, 1); px(9, 0, C.W, 2, 3); px(9, 3, C.RED, 2, 3);
      } else {
        px(9, 6, C.K, 8, 6); px(8, 4, C.K, 10, 2); px(9, 6, C.k, 1, 6); px(16, 7, C.B, 1, 2); px(9, 10, C.RED, 8, 1);
        px(14, 12, C.D, 5, 1); px(10, 12, C.D, 4, 1); px(12, 13, C.B, 1, 5); px(12, 1, C.RED, 3, 3);
      }
      // arms and musket
      switch (pose) {
        case 'stand':
          px(18, 0, C.I, 1, 6); px(18, 6, C.I, 2, 14); px(19, 6, C.i, 1, 14); px(18, 20, C.T, 2, 22); px(17, 39, C.T, 4, 5);
          px(14, 22, N.coat, 3, 8); px(16, 29, N.fac, 2, 1); px(17, 30, s, 2, 2); return;
        case 'walk1': case 'walk2': {
          const sw = pose === 'walk1' ? 2 : -2;
          px(13, 22, N.coat, 3, 7); px(13 + sw, 28, N.fac, 3, 1); px(13 + sw, 29, s, 2, 2); return;
        }
        case 'present': case 'fire': case 'smoke':
          px(14, 22, N.coat, 6, 3); px(20, 22, s, 2, 2); px(12, 25, N.coat, 4, 2);
          px(12, 22, C.T, 10, 2); px(12, 22, C.t, 10, 1); px(22, 22, C.I, 10, 2); px(22, 23, C.i, 10, 1); px(32, 22, C.I, 4, 1);
          if (pose === 'fire') flash(px, 34, 22);
          if (pose === 'smoke') smoke(px, 28, 15, true);
          return;
        case 'reload1': case 'reload2': {
          const up = pose === 'reload2' ? 6 : 0;
          px(19, 6, C.I, 2, 14); px(20, 6, C.i, 1, 14); px(19, 20, C.T, 2, 24); px(19, 1 - up, C.i, 1, 6 + up);
          px(15, 21 - up, N.coat, 3, 3); px(18, 1 - up, s, 2, 2); px(15, 24, N.coat, 3, 3); px(18, 26, s, 2, 2); return;
        }
        case 'charge': case 'lunge': {
          const k = pose === 'lunge' ? 4 : 0;
          px(14, 25, N.coat, 6, 3); px(19 + k, 27, s, 2, 2); px(12, 27, s, 2, 2);
          px(9 + k, 28, C.T, 12, 2); px(9 + k, 28, C.t, 12, 1); px(21 + k, 27, C.I, 10, 2); px(21 + k, 28, C.i, 10, 1); px(31 + k, 26, C.I, 5, 1); px(36 + k, 26, '#fff', 1, 1);
          return;
        }
        case 'run1': case 'run2': {
          const sw = pose === 'run1' ? 3 : -3;
          px(13, 22, N.coat, 3, 6); px(13 + sw, 27, s, 2, 2); return;
        }
      }
    }, bob);
  }

  /* ================= casualties ================= */
  function casualty(src, k) {
    const c = canvas(), g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    if (k === 'hit') { g.translate(W / 2, H); g.rotate(-0.25); g.drawImage(src, -W / 2, -H); return c; }
    if (k === 'kneel') { g.drawImage(src, 0, 0, W, H - 12, 0, 12, W, H - 12); return c; }
    // down: on his back, slightly faded, a little blood
    g.translate(-8, 68); g.rotate(-Math.PI / 2); g.globalAlpha = 0.92; g.drawImage(src, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 0.6; g.fillStyle = '#6e1a14'; g.fillRect(22, H - 3, 5, 2); g.fillRect(27, H - 2, 3, 1);
    return c;
  }

  /* ================= entry point ================= */
  const cache = new Map();
  const RUNVIEW = { toward: 'away', away: 'toward' };
  function get(nation, view, pose, v, kind = 'line', fp = 0) {
    const key = `${kind}:${nation}:${view}:${pose}:${v}:${kind === 'bearer' ? fp : 0}`;
    let c = cache.get(key); if (c) return c;
    let side = view === 'left' || view === 'right';
    const k2 = kind === 'bearer' ? 'guard' : kind;
    if (kind === 'gunner' && (pose === 'charge' || pose === 'lunge' || pose === 'present' || pose === 'fire' || pose === 'smoke' || pose.startsWith('reload'))) pose = 'stand';               // bearers fall and run as plain guardsmen
    if ((kind === 'bearer' || kind === 'gunner') && side) { view = 'toward'; side = false; }
    if (pose === 'hit' || pose === 'kneel' || pose === 'down') {
      c = casualty(side ? figureSide(nation, 'stand', v, k2) : figureFB(nation, view === 'away' ? 'away' : 'toward', 'stand', v, k2), pose);
      if (view === 'left') c = mirror(c);
    } else if (pose === 'run1' || pose === 'run2') {
      c = side ? figureSide(nation, pose, v, k2) : figureFB(nation, RUNVIEW[view], pose, v, kind, fp);
      if (view === 'right') c = mirror(c);
    } else {
      c = side ? figureSide(nation, pose, v, kind) : figureFB(nation, view, pose, v, kind, fp);
      if (view === 'left') c = mirror(c);
    }
    cache.set(key, c); return c;
  }
  const ANIMS = {
    idle:  { frames: ['stand', 'stand', 'stand', 'stand', 'stand', 'sway1', 'sway1', 'stand', 'stand', 'stand', 'look', 'look', 'look', 'stand', 'stand', 'stand', 'stand', 'sway2', 'sway2', 'stand', 'stand', 'stand'], fps: 4, loop: true },
    march: { frames: ['walk1', 'stand', 'walk2', 'stand'], fps: 6, loop: true },
    fire:  { frames: ['present', 'present', 'fire', 'smoke', 'smoke', 'reload1', 'reload2', 'reload1', 'reload2', 'stand'], fps: 7, loop: false },
    melee: { frames: ['charge', 'lunge', 'charge', 'charge'], fps: 6, loop: true },
    fall:  { frames: ['hit', 'kneel', 'down'], fps: 5, loop: false },
    flee:  { frames: ['run1', 'run2'], fps: 8, loop: true },
    serve: { frames: ['ears', 'ears', 'ears', 'stand', 'carry', 'carry', 'carry', 'ram1', 'ram2', 'ram1', 'ram2', 'stand', 'stand', 'stand', 'stand', 'stand'], fps: 5, loop: false }
  };
  const POSES = ['stand', 'sway1', 'look', 'walk1', 'walk2', 'present', 'fire', 'smoke', 'reload1', 'reload2', 'charge', 'lunge', 'run1', 'run2', 'hit', 'kneel', 'down'];
  return { get, ANIMS, POSES, W, H, VARIANTS: 5, BIG };
})();
