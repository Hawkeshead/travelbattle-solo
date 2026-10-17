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
    fr_heavy: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#d0202a', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#f6f3ea', crest: '#151210', helm: 'cuirassier', cuirass: true, horses: [1, 0, 1, 3, 1] },
    /* BRIGADIERS (10 Oct 2026). A general officer on a fine horse: bicorne worn
       athwart with a plume, gold epaulettes and lace, a sash instead of the
       trooper's crossbelt, a gold-laced shabraque. British: scarlet coat, dark
       blue facings, white-over-red plume, crimson sash, bay or grey charger.
       French: dark blue coat with gold embroidery, red facings, white plume
       with a tricolour edge, tricolour sash, the grey (Napoleon's Marengo, Ney's
       chestnut among the others). */
    gb_general: { coat: '#c8191e', coatDk: '#8f1014', fac: '#1c2a5a', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#c8191e'], general: true, sash: ['#9a1a2e', '#6e1020'], horses: [0, 5, 2, 0, 3] },
    fr_general: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#d0202a', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#d0202a'], general: true, sash: ['#203a8a', '#f6f3ea', '#d0202a'], horses: [5, 2, 5, 3, 0] },
    /* PRUSSIA (17 Oct 2026). Heavy: the 1813 cuirassier (Gardes du Corps,
       Brandenburg) WITHOUT a cuirass: white coat, red facings, black leather
       helmet with a brass plate and black crest, black-and-white shabraque,
       dark horses. Light: the 1st Leib-Hussars, black dolman with white braid
       across the chest, black shako with the white death's head, red-edged
       black shabraque. General: dark Prussian blue, red collar, gold lace, a
       bicorne with a white-and-black plume, the silver-and-black sash. */
    pr_heavy: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#c8191e', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1c1c1e', clothDk: '#0e0e10', lace: '#f6f3ea', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', horses: [1, 3, 1, 0, 3] },
    pr_light: { coat: '#1d1d1f', coatDk: '#0e0e10', fac: '#c8191e', breech: '#1d1d1f', breechDk: '#0e0e10', cloth: '#1c1c1e', clothDk: '#0e0e10', lace: '#c8191e', helm: 'shako', plume: ['#1f1f1f', '#1f1f1f'], badge: '#f6f3ea', hussar: '#f6f3ea', curved: true, horses: [0, 2, 3, 0, 2] },
    /* THE OTHER NATIONS (17 Oct 2026), one look per type each; the colours to
       verify are listed in the report. ru: Kutuzov's army (the Chevalier
       Guard, Don Cossacks), ru2: Barclay's (army cuirassiers, Life Guard
       Hussars), au: Austria (Kaiser Cuirassiers with the front-only black
       cuirass, Szekler Hussars), sp: Spain (Carabineros, the Maria Luisa
       Hussars), pt: Portugal, fr2: France's second army (Grenadiers a Cheval in
       bearskins on black horses, the Guard Chasseurs a Cheval in colpacks),
       pl: Poland (the Guard Light Horse with sabres, the Vistula Lancers), cf:
       the Confederation (the Saxon Garde du Corps in buff without cuirasses,
       the Berg Lancers), it: Italy & Naples (Italian dragoons, Neapolitan
       Guard Hussars). */
    ru_heavy: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#c8191e', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#a3203a', clothDk: '#6e1424', lace: '#e6c54a', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', cuirass: true, cuirassCol: ['#2a2a2e', '#151517', '#4a4a50'], horses: [1, 3, 1, 3, 1] },
    ru_light: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#1f2f63', breechDk: '#131d40', cloth: '#3a2a1e', clothDk: '#2a1e14', lace: '#c8191e', helm: 'cossack', top: '#c8191e', lance: [], horses: [2, 3, 0, 2, 3] },
    ru_general: { coat: '#1f4a2a', coatDk: '#143320', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f4a2a', clothDk: '#143320', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#e07a1a'], general: true, sash: ['#d8dce2', '#e07a1a', '#151515'], horses: [3, 0, 5, 1, 2] },
    ru2_heavy: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#1f4a2a', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1f4a2a', clothDk: '#143320', lace: '#e6c54a', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', cuirass: true, cuirassCol: ['#2a2a2e', '#151517', '#4a4a50'], horses: [0, 1, 3, 0, 1] },
    ru2_light: { coat: '#c8191e', coatDk: '#8f1014', fac: '#1f2f63', breech: '#1f2f63', breechDk: '#131d40', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6b422', helm: 'shako', plume: ['#f6f3ea', '#f6f3ea'], hussar: '#e6b422', curved: true, horses: [2, 0, 2, 3, 0] },
    ru2_general: { coat: '#1f4a2a', coatDk: '#143320', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f4a2a', clothDk: '#143320', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#151515'], general: true, sash: ['#d8dce2', '#e07a1a', '#151515'], horses: [0, 2, 3, 5, 1] },
    au_heavy: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#151515', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#c8191e', clothDk: '#8f1014', lace: '#f6f3ea', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', cuirass: true, frontOnly: true, cuirassCol: ['#2a2a2e', '#151517', '#4a4a50'], horses: [1, 0, 3, 1, 0] },
    au_light: { coat: '#2a3f73', coatDk: '#1a2a50', fac: '#e6b422', breech: '#a3203a', breechDk: '#6e1424', cloth: '#2a3f73', clothDk: '#1a2a50', lace: '#e6b422', helm: 'shako', plume: ['#1f1f1f', '#1f1f1f'], hussar: '#e6b422', curved: true, horses: [2, 0, 3, 2, 0] },
    au_general: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#c8191e', breech: '#c8191e', breechDk: '#8f1014', cloth: '#c8191e', clothDk: '#8f1014', lace: '#e6c54a', helm: 'bicorne', plume: ['#2e7a3e', '#2e7a3e'], general: true, sash: ['#e6b422', '#151515', '#e6b422'], horses: [5, 0, 3, 5, 2] },
    sp_heavy: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#d9c48a', breechDk: '#b8a46a', cloth: '#c8191e', clothDk: '#8f1014', lace: '#e6c54a', crest: '#151210', helm: 'dragoon', horses: [0, 3, 1, 0, 2] },
    sp_light: { coat: '#6fa0d8', coatDk: '#4c7aa8', fac: '#f6f3ea', breech: '#1f2f63', breechDk: '#131d40', cloth: '#6fa0d8', clothDk: '#4c7aa8', lace: '#f6f3ea', helm: 'shako', plume: ['#c8191e', '#c8191e'], hussar: '#f6f3ea', curved: true, horses: [2, 0, 3, 2, 0] },
    sp_general: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6c54a', helm: 'bicorne', plume: ['#c8191e', '#c8191e'], general: true, sash: ['#c8191e', '#a01418'], horses: [3, 5, 0, 2, 1] },
    pt_heavy: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1f2f63', clothDk: '#131d40', lace: '#f6f3ea', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', horses: [0, 1, 3, 0, 2] },
    pt_light: { coat: '#1f2f63', coatDk: '#131d40', fac: '#e6b422', breech: '#1f2f63', breechDk: '#131d40', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6b422', helm: 'shako', plume: ['#f6f3ea', '#c8191e'], curved: true, horses: [2, 3, 0, 2, 3] },
    pt_general: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6c54a', helm: 'bicorne', plume: ['#1f4a8a', '#c8191e'], general: true, sash: ['#a3203a', '#6e1424'], horses: [0, 2, 3, 5, 1] },
    fr2_heavy: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#f6f3ea', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#e6c54a', helm: 'bearskin', plume: ['#d0202a', '#d0202a'], horses: [1, 1, 1, 1, 1] },
    fr2_light: { coat: '#1f5a32', coatDk: '#143c21', fac: '#d0202a', breech: '#d0202a', breechDk: '#931218', cloth: '#1f5a32', clothDk: '#143c21', lace: '#e6b422', helm: 'colpack', bag: '#d0202a', plume: ['#1f5a32', '#d0202a'], hussar: '#e6b422', curved: true, horses: [2, 0, 3, 2, 0] },
    fr2_general: { coat: '#1c2a5a', coatDk: '#121b3c', fac: '#d0202a', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1c2a5a', clothDk: '#121b3c', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#d0202a'], general: true, sash: ['#203a8a', '#f6f3ea', '#d0202a'], horses: [3, 0, 5, 2, 1] },
    pl_heavy: { coat: '#1f2f63', coatDk: '#131d40', fac: '#a3203a', breech: '#a3203a', breechDk: '#6e1424', cloth: '#1f2f63', clothDk: '#131d40', lace: '#a3203a', helm: 'czapka', top: '#a3203a', plume: ['#f6f3ea'], curved: true, horses: [0, 3, 2, 0, 3] },
    pl_light: { coat: '#1f2f63', coatDk: '#131d40', fac: '#e6b422', breech: '#1f2f63', breechDk: '#131d40', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6b422', helm: 'czapka', top: '#e6b422', plume: ['#f6f3ea'], lance: ['#f6f3ea', '#e6b422'], horses: [2, 0, 3, 2, 0] },
    pl_general: { coat: '#1f2f63', coatDk: '#131d40', fac: '#a3203a', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#a3203a', clothDk: '#6e1424', lace: '#d8dce2', helm: 'bicorne', plume: ['#f6f3ea', '#f6f3ea'], general: true, sash: ['#d8dce2', '#a3203a'], horses: [5, 0, 3, 2, 1] },
    cf_heavy: { coat: '#d9c48a', coatDk: '#b8a46a', fac: '#c8191e', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#c8191e', clothDk: '#8f1014', lace: '#f6f3ea', crest: '#151210', helm: 'dragoon', helmCol: '#232323', helmDk: '#101010', helmHi: '#e6b422', horses: [1, 0, 3, 1, 0] },
    cf_light: { coat: '#ece8dc', coatDk: '#c8c3b6', fac: '#a3203a', breech: '#a3203a', breechDk: '#6e1424', cloth: '#a3203a', clothDk: '#6e1424', lace: '#ece8dc', helm: 'czapka', top: '#a3203a', plume: ['#f6f3ea'], lance: ['#a3203a', '#f6f3ea'], horses: [2, 3, 0, 2, 3] },
    cf_general: { coat: '#1f2f63', coatDk: '#131d40', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f2f63', clothDk: '#131d40', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#3d7bc4'], general: true, sash: ['#d8dce2', '#3d7bc4'], horses: [0, 3, 5, 2, 1] },
    it_heavy: { coat: '#1f5a32', coatDk: '#143c21', fac: '#c8191e', breech: '#e8e4d8', breechDk: '#c2bdb0', cloth: '#1f5a32', clothDk: '#143c21', lace: '#f6f3ea', crest: '#151210', helm: 'dragoon', horses: [0, 3, 1, 0, 2] },
    it_light: { coat: '#9a1a40', coatDk: '#6a1029', fac: '#f6f3ea', breech: '#1f2f63', breechDk: '#131d40', cloth: '#9a1a40', clothDk: '#6a1029', lace: '#f6f3ea', helm: 'shako', plume: ['#f6f3ea', '#f6f3ea'], hussar: '#f6f3ea', curved: true, horses: [2, 0, 3, 2, 0] },
    it_general: { coat: '#1f5a32', coatDk: '#143c21', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f5a32', clothDk: '#143c21', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#f6f3ea'], general: true, sash: ['#2e7a3e', '#f6f3ea', '#c8191e'], horses: [5, 3, 0, 2, 1] },
    pr_general: { coat: '#1f2a4a', coatDk: '#141c33', fac: '#c8191e', breech: '#ece8dc', breechDk: '#c8c3b6', cloth: '#1f2a4a', clothDk: '#141c33', lace: '#e6c54a', helm: 'bicorne', plume: ['#f6f3ea', '#151515'], general: true, sash: ['#d8dce2', '#151515', '#d8dce2'], horses: [1, 0, 3, 1, 2] }
  };
  // The generals' grey charger, a coat of its own (index 5; the troopers' coats are untouched).
  HORSE[5] = ['#b8b2a8', '#d6d0c6', '#8e887e', '#e8e4dc'];
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
      // brass by default; a nation can give it its own colour (Prussia: black leather, a brass plate)
      const hc = R.helmCol || C.B, hd = R.helmDk || C.b;
      p(1, 1, hc, 10, 5); p(9, 1, hd, 2, 5);
      if (!back) { p(0, 5, hc, 12, 1); p(1, 6, hd, 10, 1); p(4, 2, R.helmHi || '#fff2b0', 2, 2); p(3, -3, R.crest, 6, 4); p(2, -1, R.crest, 2, 3); p(8, -2, '#2a2420', 2, 3); }
      else { p(1, 5, C.b, 10, 1); p(3, -3, R.crest, 6, 4); p(5, 1, R.crest, 2, 5); }
    } else if (R.helm === 'cuirassier') {
      // steel skull, brass comb, black horsehair mane down the back, red plume on the left
      p(1, 1, '#c9ced6', 10, 5); p(8, 1, '#8a9098', 3, 5); p(2, 1, '#eef1f5', 2, 3);
      p(4, -3, C.B, 4, 4); p(5, -4, C.b, 2, 1);
      if (!back) { p(0, 5, '#b08a3c', 12, 1); p(1, 6, C.D, 10, 1); p(-1, 2, '#d0202a', 2, 6); p(7, -2, R.crest, 2, 3); }
      else { p(4, 0, R.crest, 4, 10); p(3, 2, R.crest, 6, 6); p(11, 2, '#d0202a', 2, 6); }
    } else if (R.helm === 'colpack') {
      // the fur colpack of hussars and chasseurs, its coloured bag hanging at the side, a plume in front
      p(1, -2, '#3a2a1e', 10, 8); p(9, -2, '#2a1e14', 2, 8); p(2, -3, '#4a3826', 8, 1);
      p(back ? 1 : 8, -3, R.bag || '#c8191e', 3, 3); if (R.plume) { p(back ? 8 : 2, -8, R.plume[0], 2, 4); p(back ? 8 : 2, -4, R.plume[1], 2, 2); }
      if (!back) p(1, 5, C.D, 10, 1);
    } else if (R.helm === 'czapka') {
      // the lancer cap: skull, waist and the square top in the regiment's colour
      p(2, 2, '#1f1f1f', 8, 4); p(3, 1, '#1f1f1f', 6, 1); p(0, -3, R.top, 12, 4); p(0, -3, '#f6f3ea', 12, 1); p(10, -2, '#00000033', 2, 3);
      if (!back) { p(4, 3, '#d8dce2', 3, 2); p(1, 5, C.D, 10, 1); }
      if (R.plume) p(back ? 1 : 9, -7, R.plume[0], 2, 4);
    } else if (R.helm === 'bearskin') {
      // the Grenadiers a Cheval: a tall bearskin, white cords, a red plume
      p(1, -5, '#1f1f1f', 10, 11); p(9, -4, '#3c3c3c', 2, 10); p(2, -6, '#1f1f1f', 8, 1);
      for (const [x, y] of [[3, -3], [6, 0], [4, 3], [7, -2]]) p(x, y, '#3c3c3c', 1, 1);
      if (!back) p(1, 4, '#f6f3ea', 10, 1);
      if (R.plume) p(back ? 0 : 10, -7, R.plume[0], 2, 6);
    } else if (R.helm === 'cossack') {
      // a Cossack's tall cap, its coloured top
      p(1, -4, '#151515', 10, 10); p(9, -4, '#2a2a2a', 2, 10); p(2, -5, R.top || '#c8191e', 8, 2);
      if (!back) p(1, 5, C.D, 10, 1);
    } else if (R.helm === 'bicorne') {
      // a general's bicorne worn athwart: wide black wings, gold edge and
      // loop, a national cockade, and a plume standing from the top
      p(-3, 2, '#151210', 18, 4); p(-2, 1, '#151210', 16, 1); p(0, 0, '#151210', 12, 1); p(2, -1, '#1f1a16', 8, 1);
      p(-3, 5, R.lace, 18, 1);                                              // gold edging along the brim
      if (!back) { p(5, 1, R.lace, 2, 4); p(5, 2, R.plume[1], 2, 2); }     // gold loop over the cockade
      p(4, -6, R.plume[0], 4, 5); p(5, -8, R.plume[0], 2, 2); p(4, -2, R.plume[1], 4, 1);   // the plume
    } else {
      // bell-topped shako with a plume
      p(1, 1, '#1f1f1f', 10, 5); p(0, 0, '#1f1f1f', 12, 1); p(9, 1, '#3c3c3c', 2, 5);
      if (!back) { p(4, 2, R.badge || C.B, 3, 2); p(1, 5, C.D, 10, 1); p(0, 6, C.D, 12, 1); }
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
    if (R.general) {
      // general officer: facing-coloured collar laced gold, gold epaulettes,
      // gold lace down the front, a sash at the waist, no crossbelt
      p(3, 14, R.fac, 6, 1); p(3, 13, R.lace, 6, 1);
      p(-2, 13, R.lace, 4, 2); p(10, 13, R.lace, 4, 2); p(-2, 15, '#b08a2c', 4, 1); p(10, 15, '#b08a2c', 4, 1);   // epaulettes with fringe
      if (!back) { for (let i = 0; i < 4; i++) p(5, 15 + i * 2, R.lace, 2, 1); p(3, 15, R.lace, 1, 7); p(8, 15, R.lace, 1, 7); }
      const sh = R.sash; p(0, 21, sh[0], 12, 1); p(0, 22, sh[1] || sh[0], 12, 1); p(0, 23, sh[2] || sh[1] || sh[0], 12, 1);
      if (back) { p(2, 24, R.coat, 3, 3); p(7, 24, R.coatDk, 3, 3); p(1, 22, sh[0], 2, 5); }   // coat skirts, sash ends
    } else if (!back) {
      p(3, 14, R.fac, 6, 1); p(4, 13, C.D, 4, 1);                          // collar, stock
      if (R.hussar) for (let i = 0; i < 4; i++) p(1, 15 + i * 2, R.hussar, 10, 1);   // hussar braid across the dolman
      else for (let i = 0; i < 9; i++) p(1 + i, 15 + i, C.W, 2, 1);       // crossbelt over the left shoulder
      p(0, 22, C.W, 12, 2); p(5, 22, C.B, 2, 2);                           // waist belt and buckle
      for (let i = 0; i < 3; i++) p(6, 16 + i * 2, C.B, 1, 1);
      if (R.helm === 'shako') { p(2, 15, R.fac, 1, 7); p(9, 15, R.fac, 1, 7); }   // facing-coloured plastron edges
      if (R.cuirass) { const cu = R.cuirassCol || ['#c9ced6', '#8a9098', '#eef1f5']; p(0, 15, cu[0], 12, 8); p(8, 15, cu[1], 4, 8); p(1, 15, cu[2], 2, 6); p(0, 15, '#b08a3c', 12, 1); p(1, 17, C.B, 1, 1); p(10, 17, C.B, 1, 1); p(0, 22, C.W, 12, 2); } // breastplate
    } else {
      p(3, 14, R.fac, 6, 1); for (let i = 0; i < 9; i++) p(10 - i, 15 + i, C.W, 2, 1); p(0, 22, C.W, 12, 2);
      p(2, 24, R.coat, 3, 3); p(7, 24, R.coatDk, 3, 3);                     // coat skirts over the saddle
      if (R.cuirass && !R.frontOnly) { const cu = R.cuirassCol || ['#b9bec6', '#80868e']; p(0, 15, cu[0], 12, 8); p(8, 15, cu[1], 4, 8); p(0, 15, '#b08a3c', 12, 1); p(0, 22, C.W, 12, 2); } // backplate
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
    let sab = (x0, y0, x1, y1) => {
      if (R.curved) { const mx = x0 + (x1 - x0) * .65, my = y0 + (y1 - y0) * .65, k = (y1 - y0) > 0 ? 1 : -1; o.line(bx + x0, by + y0, bx + mx, by + my, C.I, 2); o.line(bx + mx, by + my, bx + x1 + k, by + y1 + k, C.I, 2); }
      else o.line(bx + x0, by + y0, bx + x1, by + y1, C.I, 2);
      o.px(bx + x1, by + y1, '#ffffff', 1, 1); o.px(bx + x0 - 1, by + y0 - 1, C.B, 3, 2); };
    /* A lancer's lance (R.lance: its pennon's two colours, or null for none):
       the same line as the sabre's, run on past the hand and far beyond the
       point, a steel head and the pennon just below it. */
    const lanceOf = (x0, y0, x1, y1) => {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const sx = x0 - ux * 8, sy = y0 - uy * 8, ex = x0 + ux * 34, ey = y0 + uy * 34;
      o.line(bx + sx, by + sy, bx + ex, by + ey, '#6a4a2a', 1);
      o.px(bx + ex - 1, by + ey - 1, C.I, 2, 2);
      if (R.lance[0]) { const qx = ex - ux * 5, qy = ey - uy * 5; o.px(bx + qx, by + qy, R.lance[0], 4, 2); o.px(bx + qx, by + qy + 2, R.lance[1], 4, 2); }
      o.px(bx + x0 - 1, by + y0 - 1, '#5a3a22', 2, 2);
    };
    if (R.lance) { const s0 = sab; sab = (x0, y0, x1, y1) => (R.general ? s0 : lanceOf)(x0, y0, x1, y1); }
    const RA = back ? -2 : 12, LA = back ? 12 : -2;                      // RA: sword arm side
    if (pose.startsWith('gallop')) {
      // charge: sabre held out at the point, arm extended
      p(RA, 15, R.coat, 3, 4); p(RA + (back ? -1 : 1), 19, s, 2, 2);
      if (!back) sab(14, 20, 24, 30); else sab(-3, 19, -12, 6);
      p(LA, 16, R.coat, 2, 6); p(LA, 22, s, 2, 2);
    } else if (R.general && pose.startsWith('stand')) {
      // the general at rest: sword arm pointing the way forward (stand2: lowered)
      if (pose === 'stand') { p(RA, 14, R.coat, 4, 3); p(RA + (back ? -3 : 3), 13, s, 2, 2); if (!back) o.line(bx + 15, by + 13, bx + 22, by + 8, C.I, 1); else o.line(bx - 3, by + 13, bx - 10, by + 8, C.I, 1); }
      else { p(RA, 16, R.coat, 2, 6); p(RA, 22, s, 2, 2); sab(RA + 1, 22, RA + (back ? -2 : 4), 30); }
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
      o.px(30, 58, R.coat, 12, 5); o.px(42, 59, s, 4, 4); o.px(40, 56, R.helm === 'dragoon' ? C.B : R.helm === 'cuirassier' ? '#c9ced6' : R.helm === 'bicorne' ? '#151210' : '#1f1f1f', R.helm === 'bicorne' ? 8 : 5, 3); o.px(24, 58, R.breech, 6, 4); o.px(19, 59, C.D, 5, 3);
      o.line(44, 62, 56, 60, C.I, 1);
      o.g.globalAlpha = .6; o.px(32, 63, '#6e1a14', 6, 1);
    });
  }

  const cache = new Map();
  function get(nation, view, pose, v, type = 'heavy') {
    const vv = view === 'away' ? 'away' : 'toward';
    const sk = ({ british: 'gb_', french: 'fr_', prussian: 'pr_', russian: 'ru_', russian2: 'ru2_', austrian: 'au_', spanish: 'sp_', portuguese: 'pt_',
      french2: 'fr2_', polish: 'pl_', confederation: 'cf_', italian: 'it_' }[nation] || 'gb_') + type;
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
