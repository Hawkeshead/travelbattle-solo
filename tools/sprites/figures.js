/* =========================================================
   SPRITE TOOL: THE FIGURES (browser side; render-sheets.mjs drives it)

   Low-poly Napoleonic figures built from boxes, cylinders and spheres,
   toon-shaded, posed by code for each animation frame, and rendered from
   eight directions into sprite sheets. No model files are needed; a CC0
   model dropped into tools/sprites/models/<TYPE>.glb is used instead when
   present (see README.md).

   Everything is in metres: a man 1.75 tall, a horse 1.55 at the withers,
   a six-pounder's wheel 1.3 across.
   Classic script: it defines window.FIGURES for the driver's page.evaluate.
========================================================= */

(function(){
  const PALETTES = {
    british:    { coat: '#b4322c', facing: '#f1e6c9', trousers: '#6e727a', hat: '#1b1b1b', plume: '#f4f1ea', lightCoat: '#2c3b7a', heavyCoat: '#b4322c', helmet: '#c6c7c4', crest: '#1b1b1b', horse: ['#4a2f1c', '#2a1c12', '#6b4a2a'], flag: ['#1f3a8a', '#c8191e'], gun: '#3b5a3a' },
    french:     { coat: '#2b3f7f', facing: '#eee8d8', trousers: '#e8e2d2', hat: '#1b1b1b', plume: '#c8191e', lightCoat: '#2f6b3a', heavyCoat: '#2b3f7f', helmet: '#c0c4c8', crest: '#c8191e', horse: ['#3a2416', '#5c3d22', '#1e1612'], flag: ['#1f3a8a', '#f6f3ea', '#c8191e'], gun: '#4e6b3a' },
    prussian:   { coat: '#1f2a44', facing: '#a32030', trousers: '#5b5f66', hat: '#151515', plume: '#f2f2ee', lightCoat: '#1f2a44', heavyCoat: '#e8e8e4', helmet: '#1b1b1b', crest: '#f2f2ee', horse: ['#2a1c12', '#4a2f1c', '#7a5a3a'], flag: ['#151515', '#f2f2ee'], gun: '#3a4a5a' },
    spanish:    { coat: '#e9e4d8', facing: '#b3261e', trousers: '#e9e4d8', hat: '#1b1b1b', plume: '#c8191e', lightCoat: '#c9a227', heavyCoat: '#e9e4d8', helmet: '#c6c7c4', crest: '#c8191e', horse: ['#4a2f1c', '#2a1c12', '#8a6a4a'], flag: ['#c8191e', '#e6b422'], gun: '#4e4a3a' },
    portuguese: { coat: '#2b3f7f', facing: '#f1e6c9', trousers: '#e8e2d2', hat: '#1b1b1b', plume: '#c8191e', lightCoat: '#2b3f7f', heavyCoat: '#2b3f7f', helmet: '#c6c7c4', crest: '#1b1b1b', horse: ['#4a2f1c', '#6b4a2a', '#2a1c12'], flag: ['#1f4a8a', '#f6f3ea'], gun: '#3b5a3a' },
    polish:     { coat: '#2b3f7f', facing: '#a3203a', trousers: '#2b3f7f', hat: '#1b1b1b', plume: '#f2f2ee', lightCoat: '#2b3f7f', heavyCoat: '#2b3f7f', helmet: '#c0c4c8', crest: '#a3203a', horse: ['#3a2416', '#1e1612', '#6b4a2a'], flag: ['#a3203a', '#f2f2ee'], gun: '#4e6b3a' },
    austrian:   { coat: '#efece4', facing: '#8a6a1a', trousers: '#d8d4c8', hat: '#1b1b1b', plume: '#e6b422', lightCoat: '#2f6b3a', heavyCoat: '#efece4', helmet: '#1b1b1b', crest: '#e6b422', horse: ['#4a2f1c', '#2a1c12', '#8a6a4a'], flag: ['#e6b422', '#151515'], gun: '#5a5a3a' },
    russian:    { coat: '#2f4a2e', facing: '#c8191e', trousers: '#e8e2d2', hat: '#1b1b1b', plume: '#f2f2ee', lightCoat: '#2f4a2e', heavyCoat: '#e8e8e4', helmet: '#1b1b1b', crest: '#1b1b1b', horse: ['#2a1c12', '#4a2f1c', '#6b4a2a'], flag: ['#2f4a2e', '#e07a1a'], gun: '#3a5a4a' },
  };
  const SKIN = '#d9b48c', STEEL = '#b9bcc0', WOOD = '#6e5235', BRASS = '#c9a84a';

  let gradient = null;
  function grad(){
    if(gradient) return gradient;
    const d = new Uint8Array([80, 150, 255]);
    gradient = new THREE.DataTexture(d, 3, 1, THREE.LuminanceFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter; gradient.generateMipmaps = false; gradient.needsUpdate = true;
    return gradient;
  }
  const mat = c => new THREE.MeshToonMaterial({ color: new THREE.Color(c).convertSRGBToLinear(), gradientMap: grad() });
  const box = (w, h, d, c) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
  const cyl = (rt, rb, h, c, seg = 10) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(c));
  const sph = (r, c) => new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat(c));
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  /* A pivot: a group whose origin is the joint, with the limb hanging below it. */
  const joint = (x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); return g; };

  /* ---------- a man ---------- */
  /* kind: 'line' (musket), 'crew' (rammer), 'bearer' (the colour), 'rider' (legs astride, no musket, sabre). */
  function man(P, kind, opts = {}){
    const g = new THREE.Group();
    const coat = opts.coat || P.coat;
    const hips = joint(0, 0.95, 0); g.add(hips);
    // legs hang from the hips
    const legL = joint(-0.1, 0, 0), legR = joint(0.1, 0, 0);
    for(const [leg, s] of [[legL, -1], [legR, 1]]){
      leg.add(at(box(0.15, 0.5, 0.17, P.trousers), 0, -0.25, 0));        // the thigh
      const knee = joint(0, -0.5, 0); leg.add(knee); leg.knee = knee;
      knee.add(at(box(0.14, 0.42, 0.16, '#1b1b1b'), 0, -0.22, 0));       // gaiters and shoes
      knee.add(at(box(0.16, 0.08, 0.24, '#1b1b1b'), 0, -0.45, 0.03));
      if(kind === 'rider'){ leg.rotation.x = -1.3; knee.rotation.x = 1.6; leg.position.x = s * 0.22; }
      hips.add(leg);
    }
    const torso = joint(0, 0, 0); hips.add(torso);
    torso.add(at(box(0.4, 0.6, 0.24, coat), 0, 0.3, 0));
    torso.add(at(box(0.18, 0.5, 0.02, P.facing), 0, 0.3, 0.125));        // the lapels / plastron
    torso.add(at(box(0.42, 0.06, 0.26, opts.belt || '#f1e6c9'), 0, 0.03, 0));   // the belt
    if(opts.cuirass){ torso.add(at(box(0.42, 0.42, 0.28, P.helmet), 0, 0.36, 0)); }
    if(opts.sash){ torso.add(at(box(0.44, 0.08, 0.27, opts.sash), 0, 0.12, 0)); }
    // the head and the hat
    const head = joint(0, 0.62, 0); torso.add(head);
    head.add(at(sph(0.13, SKIN), 0, 0.1, 0));
    if(opts.hat === 'bicorne'){ head.add(at(box(0.46, 0.14, 0.12, P.hat), 0, 0.26, 0)); }
    else if(opts.hat === 'helmet'){ head.add(at(sph(0.15, P.helmet), 0, 0.14, 0)); head.add(at(box(0.05, 0.1, 0.3, P.crest), 0, 0.3, -0.02)); }
    else if(opts.hat === 'czapka'){ head.add(at(box(0.26, 0.2, 0.26, P.hat), 0, 0.3, 0)); head.add(at(box(0.3, 0.04, 0.3, P.facing), 0, 0.42, 0)); }
    else { head.add(at(cyl(0.14, 0.12, 0.26, P.hat), 0, 0.3, 0)); head.add(at(cyl(0.03, 0.03, 0.16, P.plume), 0.1, 0.5, 0)); head.add(at(box(0.08, 0.1, 0.01, BRASS), 0, 0.33, 0.14)); }
    // arms hang from the shoulders
    const armL = joint(-0.24, 0.55, 0), armR = joint(0.24, 0.55, 0); torso.add(armL, armR);
    for(const a of [armL, armR]){ a.add(at(box(0.11, 0.3, 0.12, coat), 0, -0.15, 0)); const fore = joint(0, -0.3, 0); fore.add(at(box(0.1, 0.28, 0.1, coat), 0, -0.13, 0)); fore.add(at(sph(0.06, SKIN), 0, -0.3, 0)); a.add(fore); a.fore = fore; }
    // what he carries, in his right hand
    let carry = null;
    if(kind === 'line'){ carry = new THREE.Group(); carry.add(at(box(0.04, 1.35, 0.04, WOOD), 0, 0.3, 0)); carry.add(at(box(0.025, 0.7, 0.025, STEEL), 0, 0.75, 0.015)); carry.add(at(box(0.015, 0.3, 0.015, STEEL), 0, 1.15, 0)); }
    if(kind === 'crew'){ carry = new THREE.Group(); carry.add(at(cyl(0.02, 0.02, 1.6, WOOD), 0, 0.4, 0)); carry.add(at(cyl(0.06, 0.06, 0.12, '#3a3a3a'), 0, 1.2, 0)); }
    if(kind === 'bearer'){ carry = new THREE.Group(); carry.add(at(cyl(0.02, 0.02, 2.4, WOOD), 0, 0.8, 0)); const flag = new THREE.Group(); const cols = P.flag; cols.forEach((c, i) => flag.add(at(box(0.02, 0.6 / cols.length, 0.7, c), 0, 0.3 - (i + 0.5) * 0.6 / cols.length, 0.35))); flag.position.y = 1.7; carry.add(flag); carry.flag = flag; carry.add(at(sph(0.05, BRASS), 0, 2.0, 0)); }
    if(kind === 'rider'){ carry = new THREE.Group(); carry.add(at(box(0.025, 0.95, 0.03, STEEL), 0, 0.45, 0)); carry.add(at(sph(0.05, BRASS), 0, 0, 0)); }
    if(carry){ armR.fore.add(carry); carry.position.y = -0.3; }
    g.parts = { hips, torso, head, legL, legR, armL, armR, carry };
    return g;   // faces +Z (the camera) at yaw 0
  }
  /* ---------- a horse, with its rider on top ---------- */
  function horse(P, color){
    const g = new THREE.Group();
    const body = joint(0, 1.05, 0); g.add(body);
    body.add(at(box(0.45, 0.55, 1.3, color), 0, 0, 0));
    const neck = joint(0, 0.2, 0.6); body.add(neck);
    neck.add(at(box(0.25, 0.65, 0.3, color), 0, 0.25, 0.1).rotateX(0.5));
    neck.add(at(box(0.2, 0.22, 0.45, color), 0, 0.6, 0.35));
    neck.add(at(box(0.06, 0.45, 0.1, '#1b1b1b'), 0, 0.45, 0.05));   // the mane
    body.add(at(box(0.08, 0.5, 0.12, '#1b1b1b'), 0, -0.1, -0.7).rotateX(-0.5));   // the tail
    body.add(at(box(0.3, 0.1, 0.5, '#5a3a22'), 0, 0.3, -0.05));     // the saddle
    body.add(at(box(0.48, 0.3, 0.4, P.facing), 0, 0.1, -0.05));      // the shabraque
    const legs = [];
    for(const [x, z] of [[-0.16, 0.45], [0.16, 0.45], [-0.16, -0.45], [0.16, -0.45]]){
      const l = joint(x, -0.2, z); l.add(at(box(0.12, 0.85, 0.14, color), 0, -0.42, 0)); l.add(at(box(0.13, 0.08, 0.16, '#1b1b1b'), 0, -0.86, 0)); body.add(l); legs.push(l);
    }
    g.parts = { body, neck, legs };
    return g;
  }
  function mounted(P, opts){
    const h = horse(P, P.horse[opts.horse % P.horse.length]);
    const r = man(P, 'rider', opts);
    r.position.set(0, 0.35 - 0.95, -0.05);   // his hips on the saddle
    h.parts.body.add(r);
    h.rider = r;
    return h;
  }
  /* ---------- the gun ---------- */
  function gun(P){
    const g = new THREE.Group();
    const carriage = joint(0, 0.55, 0); g.add(carriage);
    carriage.add(at(box(0.5, 0.18, 1.0, P.gun), 0, 0, -0.1));
    carriage.add(at(box(0.3, 0.14, 1.3, P.gun), 0, -0.12, -0.9).rotateX(0.18));   // the trail
    const barrel = joint(0, 0.2, 0.1); carriage.add(barrel);
    barrel.add(at(cyl(0.09, 0.12, 1.5, '#5a5a4a'), 0, 0, 0.1).rotateX(Math.PI / 2));
    barrel.add(at(sph(0.1, '#5a5a4a'), 0, 0, -0.7));
    for(const x of [-0.35, 0.35]){
      const w = at(cyl(0.65, 0.65, 0.1, WOOD, 12), x, 0.1, 0.05); w.rotation.z = Math.PI / 2; carriage.add(w);
      carriage.add(at(cyl(0.12, 0.12, 0.14, '#3a3a3a', 8), x, 0.1, 0.05).rotateZ(Math.PI / 2));
      for(let s = 0; s < 4; s++){ const sp = at(box(0.03, 1.2, 0.03, WOOD), x, 0.1, 0.05); sp.rotation.x = s * Math.PI / 4; carriage.add(sp); }
    }
    g.parts = { carriage, barrel };
    return g;
  }

  /* ---------- the figures per unit type ---------- */
  const FRAME = {
    INFANTRY:      { w: 48, h: 64, scale: 0.56, span: 2.4 },
    GUARD:         { w: 48, h: 64, scale: 0.56, span: 2.4 },
    GUARD_BEARER:  { w: 64, h: 88, scale: 0.80, span: 3.3 },
    ARTILLERY:     { w: 48, h: 64, scale: 0.56, span: 2.4 },
    ARTILLERY_GUN: { w: 112, h: 96, scale: 0.96, span: 3.0, ay: 0.9 },
    LIGHT_CAV:     { w: 72, h: 72, scale: 0.64, span: 2.9 },
    HEAVY_CAV:     { w: 72, h: 72, scale: 0.64, span: 2.9 },
    BRIGADIER:     { w: 72, h: 80, scale: 0.64, span: 3.1 },
  };
  const ANIMS = {
    foot:   { idle: { frames: 4, fps: 2, loop: true }, march: { frames: 8, fps: 8, loop: true }, fire: { frames: 8, fps: 8, loop: false }, melee: { frames: 6, fps: 8, loop: true }, fall: { frames: 6, fps: 8, loop: false } },
    crew:   { idle: { frames: 4, fps: 2, loop: true }, march: { frames: 8, fps: 8, loop: true }, serve: { frames: 8, fps: 6, loop: false }, fall: { frames: 6, fps: 8, loop: false } },
    bearer: { idle: { frames: 6, fps: 3, loop: true }, march: { frames: 8, fps: 8, loop: true }, fall: { frames: 6, fps: 8, loop: false } },
    horse:  { idle: { frames: 4, fps: 2, loop: true }, march: { frames: 8, fps: 8, loop: true }, charge: { frames: 8, fps: 12, loop: true }, melee: { frames: 6, fps: 8, loop: true }, fall: { frames: 6, fps: 8, loop: false } },
    gun:    { idle: { frames: 1, fps: 1, loop: true }, fire: { frames: 6, fps: 8, loop: false }, wreck: { frames: 1, fps: 1, loop: false } },
  };
  function build(type, P, variant){
    switch(type){
      case 'INFANTRY': return { fig: man(P, 'line'), anims: ANIMS.foot };
      case 'GUARD': return { fig: man(P, 'line', { hat: 'bearskin' }), anims: ANIMS.foot };
      case 'GUARD_BEARER': return { fig: man(P, 'bearer'), anims: ANIMS.bearer };
      case 'ARTILLERY': return { fig: man(P, 'crew', { coat: P.gun === '#3b5a3a' ? '#2b3f7f' : P.coat }), anims: ANIMS.crew };
      case 'ARTILLERY_GUN': return { fig: gun(P), anims: ANIMS.gun };
      case 'LIGHT_CAV': return { fig: mounted(P, { coat: P.lightCoat, horse: variant, hat: P === PALETTES.polish ? 'czapka' : 'shako' }), anims: ANIMS.horse };
      case 'HEAVY_CAV': return { fig: mounted(P, { coat: P.heavyCoat, horse: variant + 1, hat: 'helmet', cuirass: true }), anims: ANIMS.horse };
      case 'BRIGADIER': return { fig: mounted(P, { coat: P.coat, horse: 2, hat: 'bicorne', sash: P.facing }), anims: ANIMS.horse };
    }
    return null;
  }

  /* ---------- the poses: t runs 0..1 through the animation ---------- */
  const S = (t, k = 1) => Math.sin(t * Math.PI * 2 * k);
  function poseMan(fig, anim, t, kind){
    const p = fig.parts;
    // rest
    p.hips.position.y = 0.95; p.hips.rotation.set(0, 0, 0); p.torso.rotation.set(0, 0, 0);
    p.legL.rotation.x = p.legR.rotation.x = kind === 'rider' ? -1.3 : 0;
    p.legL.knee.rotation.x = p.legR.knee.rotation.x = kind === 'rider' ? 1.6 : 0;
    p.armL.rotation.set(0, 0, 0.15); p.armR.rotation.set(0, 0, -0.15); p.armL.fore.rotation.x = p.armR.fore.rotation.x = -0.2;
    if(p.carry){ p.carry.rotation.set(0, 0, 0); p.carry.position.set(0, -0.3, 0); }
    const shoulder = () => { if(p.carry && kind === 'line'){ p.armR.rotation.set(-0.2, 0, -0.2); p.armR.fore.rotation.x = -1.9; p.carry.rotation.set(0.25, 0, 0); p.carry.position.set(0.05, -0.25, 0.05); } };
    switch(anim){
      case 'idle': p.hips.position.y = 0.95 + 0.01 * S(t); p.head.rotation.y = 0.1 * S(t); shoulder(); if(kind === 'bearer') p.carry.flag.rotation.y = 0.3 * S(t); break;
      case 'march': { const s = S(t); p.legL.rotation.x = 0.6 * s; p.legR.rotation.x = -0.6 * s; p.armL.rotation.x = -0.5 * s; p.armR.rotation.x = 0.5 * s; p.hips.position.y = 0.95 + 0.025 * Math.abs(S(t, 2)); shoulder(); if(kind === 'bearer') p.carry.flag.rotation.y = 0.5 * S(t); break; }
      case 'fire': { // up to the aim, the flash at the third frame, recoil, back down
        const k = t * 8;
        const aim = Math.min(1, k / 2);
        p.armR.rotation.set(-1.5 * aim, 0, -0.15); p.armL.rotation.set(-1.45 * aim, 0.3 * aim, 0.15); p.armR.fore.rotation.x = -0.3 * aim; p.armL.fore.rotation.x = -0.3 * aim;
        if(p.carry){ p.carry.rotation.set(Math.PI / 2 * aim + 0.08, 0, 0); p.carry.position.set(0.0, -0.3, 0.1 * aim); }
        if(k >= 2 && k < 3) fig.flash = true;
        p.torso.rotation.x = k >= 2 && k < 4 ? -0.12 : 0;
        break; }
      case 'melee': { const s = Math.max(0, S(t)); p.torso.rotation.x = 0.35 * s; p.legL.rotation.x = -0.6 * s; p.legR.rotation.x = 0.5 * s; p.armR.rotation.x = -1.6 * s; p.armL.rotation.x = -1.4 * s; if(p.carry){ p.carry.rotation.x = 1.3 * s; } break; }
      case 'serve': { const s = Math.max(0, S(t)); p.torso.rotation.x = 0.45 * s; p.armR.rotation.x = -1.2 - 0.6 * s; p.armL.rotation.x = -1.0 - 0.6 * s; if(p.carry){ p.carry.rotation.x = 1.4; p.carry.position.set(0, -0.3, 0.3 + 0.6 * s); } break; }
      case 'fall': { const k = Math.min(1, t * 1.25); const e = k * k; p.hips.rotation.x = -1.45 * e; p.hips.position.y = 0.95 - 0.75 * e; p.legL.rotation.x = 0.2 * e; p.legR.rotation.x = -0.3 * e; p.legL.knee.rotation.x = 0.4 * e; p.armL.rotation.x = -1.2 * e; p.armR.rotation.x = -0.6 * e; if(p.carry) p.carry.rotation.set(1.2 * e, 0, 0.6 * e); break; }
    }
  }
  function poseHorse(fig, anim, t){
    const p = fig.parts, r = fig.rider;
    p.body.position.y = 1.05; p.body.rotation.set(0, 0, 0); p.neck.rotation.x = 0;
    p.legs.forEach(l => l.rotation.x = 0);
    poseMan(r, 'idle', t, 'rider');
    switch(anim){
      case 'idle': p.body.position.y = 1.05 + 0.01 * S(t); p.neck.rotation.x = 0.08 * S(t); break;
      case 'march': { const s = S(t); p.legs[0].rotation.x = 0.45 * s; p.legs[3].rotation.x = 0.45 * s; p.legs[1].rotation.x = -0.45 * s; p.legs[2].rotation.x = -0.45 * s; p.body.position.y = 1.05 + 0.02 * Math.abs(S(t, 2)); break; }
      case 'charge': { const s = S(t); p.legs[0].rotation.x = p.legs[1].rotation.x = 0.9 * s; p.legs[2].rotation.x = p.legs[3].rotation.x = -0.9 * s; p.body.position.y = 1.05 + 0.08 * Math.max(0, S(t, 1)); p.body.rotation.x = 0.15 * s; p.neck.rotation.x = 0.35; r.parts.torso.rotation.x = 0.35; if(r.parts.carry){ r.parts.armR.rotation.x = -1.6; r.parts.carry.rotation.x = 0.6; } break; }
      case 'melee': { const s = Math.max(0, S(t)); r.parts.armR.rotation.set(-2.2 + 1.4 * s, 0, -0.4); r.parts.torso.rotation.x = 0.2 * s; p.legs[0].rotation.x = p.legs[1].rotation.x = 0.5 * s; p.body.rotation.x = 0.1 * s; break; }
      case 'fall': { const k = Math.min(1, t * 1.25); const e = k * k; p.body.rotation.z = 1.5 * e; p.body.position.y = 1.05 - 0.6 * e; p.neck.rotation.x = 0.6 * e; p.legs.forEach((l, i) => l.rotation.x = (i % 2 ? 0.5 : -0.5) * e); break; }
    }
  }
  function poseGun(fig, anim, t){
    const p = fig.parts;
    p.barrel.position.z = 0.1; p.carriage.rotation.set(0, 0, 0); p.carriage.position.y = 0.55; fig.flash = false;
    if(anim === 'fire'){ const k = t * 6; if(k < 1) fig.flash = true; p.barrel.position.z = 0.1 - 0.25 * Math.max(0, 1 - Math.abs(k - 1) / 2); }
    if(anim === 'wreck'){ p.carriage.rotation.z = 0.5; p.carriage.position.y = 0.3; p.barrel.rotation.y = 0.4; }
  }

  /* ---------- rendering a type's sheet ---------- */
  function renderSheet(type, nation, variant = 0){
    const P = PALETTES[nation] || PALETTES.french;
    const F = FRAME[type];
    const { fig, anims } = build(type, P, variant);
    const dirs = 8;
    const animNames = Object.keys(anims);
    const rows = animNames.length * dirs;
    const cols = Math.max(...animNames.map(a => anims[a].frames));
    const sheet = document.createElement('canvas'); sheet.width = cols * F.w; sheet.height = rows * F.h;
    const sg = sheet.getContext('2d');
    const renderer = window.__renderer || (window.__renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true }));
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(1); renderer.setSize(F.w, F.h, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#e8eeff', '#5a4a30', 0.7));
    const sun = new THREE.DirectionalLight('#ffe8c0', 0.9); sun.position.set(3, 6, 4); scene.add(sun);
    const rig = new THREE.Group(); rig.add(fig); scene.add(rig);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffe36a' }));
    scene.add(flash); flash.visible = false;
    // an orthographic camera looking down at 30 degrees, framing `span` metres of height
    const elev = 30 * Math.PI / 180;
    const cam = new THREE.OrthographicCamera(-F.span * F.w / F.h / 2, F.span * F.w / F.h / 2, F.span * (1 - (F.ay ? 1 - F.ay : 0.06)), -F.span * (F.ay ? 1 - F.ay : 0.06), 0.1, 50);
    cam.position.set(0, Math.sin(elev) * 20, Math.cos(elev) * 20); cam.lookAt(0, 0, 0);
    const pose = (anim, t) => {
      fig.flash = false;
      if(type === 'ARTILLERY_GUN') poseGun(fig, anim, t);
      else if(fig.rider) poseHorse(fig, anim, t);
      else poseMan(fig, anim, t, type === 'GUARD_BEARER' ? 'bearer' : type === 'ARTILLERY' ? 'crew' : 'line');
    };
    let row = 0;
    for(const a of animNames){
      const n = anims[a].frames;
      for(let d = 0; d < dirs; d++){
        rig.rotation.y = d * Math.PI / 4;
        for(let f = 0; f < n; f++){
          pose(a, n > 1 ? f / n : 0);
          flash.visible = !!fig.flash;
          if(flash.visible){
            // at the muzzle: for a man his right hand's reach, for the gun the barrel's mouth
            const v = new THREE.Vector3(0, 1.25, 1.1); if(type === 'ARTILLERY_GUN') v.set(0, 0.75, 1.1);
            v.applyAxisAngle(new THREE.Vector3(0, 1, 0), rig.rotation.y); flash.position.copy(v);
          }
          renderer.render(scene, cam);
          sg.drawImage(renderer.domElement, f * F.w, row * F.h);
        }
        row++;
      }
    }
    outline(sheet, F.w, F.h);
    renderer.renderLists.dispose();
    return { dataUrl: sheet.toDataURL('image/webp', 0.86), meta: { frameW: F.w, frameH: F.h, dirs, anchorY: F.ay || 1, displayScale: F.scale, anims, nation, type, madeBy: 'tools/sprites/render-sheets.mjs (procedural figures)' } };
  }
  /* The game's one-pixel dark outline round every frame, so figures read against the ground. */
  function outline(sheet, fw, fh){
    const W = sheet.width, H = sheet.height;
    const sil = document.createElement('canvas'); sil.width = W; sil.height = H;
    const s = sil.getContext('2d'); s.drawImage(sheet, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = 'rgba(20,13,8,0.92)'; s.fillRect(0, 0, W, H);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d');
    for(let y = 0; y < H; y += fh) for(let x = 0; x < W; x += fw){
      g.save(); g.beginPath(); g.rect(x, y, fw, fh); g.clip();
      for(const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.drawImage(sil, x, y, fw, fh, x + dx, y + dy, fw, fh);
      g.restore();
    }
    g.drawImage(sheet, 0, 0);
    const sg = sheet.getContext('2d'); sg.clearRect(0, 0, W, H); sg.drawImage(out, 0, 0);
  }
  window.FIGURES = { renderSheet, PALETTES, FRAME, ANIMS, TYPES: Object.keys(FRAME) };
})();
