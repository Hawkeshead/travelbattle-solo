/* Grognards pixel artillery, rebuilt: the field gun is modelled in simple 3D (wheels with spokes, axle,
   sloping carriage cheeks and trail, trunnions, a tapered bronze barrel with muzzle swell and cascabel)
   and rendered pixel by pixel with a depth buffer, so the barrel always sits on the carriage correctly
   from any angle. Flat shading in three tones, a dark rim on the silhouette, no blur.
   Canvas 112 x 96, wheels and trail on the ground, centre x 56; headroom above for smoke.
   Views: toward (muzzle towards you and to the right), away (muzzle away and to the left).
   Poses: idle, fire1 (flash, recoil), fire2-fire4 (smoke billows and clears), wreck. */
const ART = (() => {
  const W = 112, H = 96;
  const PAL = {
    british: { car: '#7a8892', iron: '#2b2b2d', bronze: '#bf9440' },   // grey carriage
    french:  { car: '#62703a', iron: '#2b2b2d', bronze: '#bf9440' }    // olive green carriage
  };
  const VIEW = {
    toward: { yaw: 50 * Math.PI / 180, k: 1.2, ox: 54, oy: 86 },
    away:   { yaw: 228 * Math.PI / 180, k: 1.05, ox: 56, oy: 80 }
  };
  const PITCH = 34 * Math.PI / 180;
  const LIGHT = norm([-0.45, 0.75, 0.55]);
  function norm(v) { const l = Math.hypot(...v) || 1; return v.map(a => a / l); }
  function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }

  /* ---------- mesh building ---------- */
  function Mesh() { this.f = []; }
  Mesh.prototype.poly = function (pts, col) { this.f.push({ pts, col }); };
  Mesh.prototype.hexa = function (v, col) {   // v: 8 corners, 0-3 one end, 4-7 the other, same winding
    const q = (a, b, c, d) => this.poly([v[a], v[b], v[c], v[d]], col);
    q(0, 1, 2, 3); q(4, 5, 6, 7); q(0, 1, 5, 4); q(1, 2, 6, 5); q(2, 3, 7, 6); q(3, 0, 4, 7);
  };
  Mesh.prototype.box = function (x0, x1, y0, y1, z0, z1, col) {
    this.hexa([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], col);
  };
  // cylinder along an axis: 'z' (barrel) or 'x' (axle, hub)
  Mesh.prototype.cyl = function (axis, c1, c2, a0, a1, r0, r1, col, seg = 14) {
    const P = (a, r, t) => { const u = Math.cos(t) * r, w = Math.sin(t) * r; return axis === 'z' ? [c1 + u, c2 + w, a] : [a, c1 + u, c2 + w]; };
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg * Math.PI * 2, t1 = (i + 1) / seg * Math.PI * 2;
      this.poly([P(a0, r0, t0), P(a0, r0, t1), P(a1, r1, t1), P(a1, r1, t0)], col);
    }
    const cap = (a, r) => { const p = []; for (let i = 0; i < seg; i++) p.push(P(a, r, i / seg * Math.PI * 2)); this.poly(p, col); };
    cap(a0, r0); cap(a1, r1);
  };
  // a wheel standing in the y-z plane at x = xw
  Mesh.prototype.wheel = function (xw, cy, cz, R, wood, iron, seg = 20) {
    const t = 1.6, rim = 2.2;
    const P = (r, a, x) => [x, cy + Math.cos(a) * r, cz + Math.sin(a) * r];
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      for (const x of [xw - t / 2, xw + t / 2]) this.poly([P(R - rim, a0, x), P(R - rim, a1, x), P(R, a1, x), P(R, a0, x)], wood);   // felloe faces
      this.poly([P(R, a0, xw - t / 2), P(R, a1, xw - t / 2), P(R, a1, xw + t / 2), P(R, a0, xw + t / 2)], iron);                      // iron tyre
      this.poly([P(R - rim, a0, xw - t / 2), P(R - rim, a1, xw - t / 2), P(R - rim, a1, xw + t / 2), P(R - rim, a0, xw + t / 2)], wood);
    }
    for (let s = 0; s < 12; s++) {   // spokes
      const a = s / 12 * Math.PI * 2 + 0.13, w = 0.12, r0 = 2.6, r1 = R - rim + 0.3;
      const c = [[r0, a - w * 2.2], [r1, a - w], [r1, a + w], [r0, a + w * 2.2]];
      const v = []; for (const x of [xw - 0.5, xw + 0.5]) for (const [r, aa] of c) v.push(P(r, aa, x));
      this.hexa([v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]], wood);
    }
    this.cyl('x', cy, cz, xw - 2.4, xw + 2.4, 2.6, 2.6, iron, 10);   // hub
  };

  /* ---------- the gun ---------- */
  function gunMesh(nation, opt) {
    const p = PAL[nation], m = new Mesh();
    const R = 15, WX = 12, AY = R;           // wheel radius, half track, axle height
    const rec = opt.recoil || 0;             // recoil pushes everything back along -z
    const z = v => v - rec;
    if (!opt.wreck) { m.wheel(-WX, AY, z(0), R, p.car, p.iron); m.wheel(WX, AY, z(0), R, p.car, p.iron); }
    else { m.wheel(-WX, AY, z(0), R, p.car, p.iron); }
    m.box(-WX + 1, WX - 1, AY - 1.4, AY + 1.4, z(-1.4), z(1.4), p.iron);                   // axle tree
    // two cheeks: tall at the front over the axle, sloping down to the trail on the ground behind
    for (const s of [-1, 1]) {
      const xi = s * 4.2, xo = s * 6.2, bi = s * 2.2, bo = s * 4.0;
      m.hexa([[xi, AY - 3, z(6)], [xo, AY - 3, z(6)], [xo, AY + 6, z(6)], [xi, AY + 6, z(6)],
              [bi, 0, z(-34)], [bo, 0, z(-34)], [bo, 4, z(-34)], [bi, 4, z(-34)]], p.car);
    }
    m.box(-4, 4, 0, 3.5, z(-38), z(-31), p.car);                                           // trail end
    m.box(-4.5, 4.5, 0, 1, z(-38.5), z(-36), p.iron);                                      // trail plate
    for (let k = 0; k < 3; k++) m.box(-4.5, 4.5, AY + 2 - k * 4.5, AY + 3 - k * 4.5, z(-6 - k * 9), z(-4 - k * 9), p.iron); // transoms
    // barrel resting in the trunnion seats on top of the cheeks
    const BY = AY + 9, dip = opt.wreck ? -0.28 : 0;
    const bz = (v) => z(v), by = (v, zz) => BY + (zz) * dip;
    m.cyl('z', 0, BY, bz(-11), bz(-8), 2.2, 4.2, p.bronze);                                 // breech
    m.cyl('z', 0, BY, bz(-8), bz(4), 4.2, 3.6, p.bronze);                                   // reinforce
    m.cyl('z', 0, BY, bz(4), bz(26), 3.2, 2.6, p.bronze);                                   // chase
    m.cyl('z', 0, BY, bz(26), bz(30), 3.4, 3.4, p.bronze);                                  // muzzle swell
    m.cyl('z', 0, BY, bz(30), bz(30.5), 1.6, 1.6, '#111111', 10);                           // the bore
    m.cyl('z', 0, BY, bz(-14), bz(-11), 1.6, 1.6, p.bronze, 8);                             // cascabel
    m.cyl('x', BY, bz(0), -6.5, 6.5, 1.5, 1.5, p.bronze, 8);                                // trunnions
    if (dip) {   // tilt the whole wreck onto its missing wheel
      for (const f of m.f) f.pts = f.pts.map(([x, y, zz]) => { const a = -0.32; return [x * Math.cos(a) - y * Math.sin(a), Math.max(0, x * Math.sin(a) + y * Math.cos(a) + 4), zz]; });
    }
    return { m, muzzle: [0, BY, z(30.5)] };
  }

  /* ---------- rasteriser with a depth buffer ---------- */
  function project(v, V) {
    const [x, y, z] = v, c = Math.cos(V.yaw), s = Math.sin(V.yaw);
    const x1 = x * c + z * s, z1 = -x * s + z * c;          // yaw: +z (muzzle) turns towards +x and the viewer
    const sx = V.ox + x1 * V.k, sy = V.oy + (-y * Math.cos(PITCH) + z1 * Math.sin(PITCH)) * V.k;
    const d = z1 * Math.cos(PITCH) + y * Math.sin(PITCH);   // larger is nearer the eye
    return [sx, sy, d];
  }
  function render(mesh, V, ctx) {
    const img = ctx.getImageData(0, 0, W, H), D = img.data, Z = new Float32Array(W * H).fill(-1e9);
    for (const f of mesh.f) {
      const P = f.pts.map(v => project(v, V));
      // normal in screen-aligned space for lighting
      const a = f.pts[0], b = f.pts[1], c3 = f.pts[2];
      const r = v => { const [x, y, z] = v, cc = Math.cos(V.yaw), ss = Math.sin(V.yaw); const x1 = x * cc + z * ss, z1 = -x * ss + z * cc; return [x1, y * Math.cos(PITCH) - z1 * Math.sin(PITCH), z1 * Math.cos(PITCH) + y * Math.sin(PITCH)]; };
      const A = r(a), B = r(b), Cc = r(c3);
      let n = norm([(B[1] - A[1]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[1] - A[1]), (B[2] - A[2]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[2] - A[2]), (B[0] - A[0]) * (Cc[1] - A[1]) - (B[1] - A[1]) * (Cc[0] - A[0])]);
      if (n[2] < 0) n = n.map(q => -q);
      const lit = 0.5 + 0.62 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      const band = lit > 0.98 ? 1.12 : lit > 0.78 ? 0.92 : 0.7;          // three flat tones
      const rgb = hex(f.col).map(q => Math.min(255, Math.round(q * band)));
      for (let i = 1; i < P.length - 1; i++) tri(P[0], P[i], P[i + 1], rgb, D, Z);
    }
    // a dark rim around the silhouette for crisp edges
    const out = new Uint8ClampedArray(D);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; if (!D[i + 3]) continue;
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X < 0 || Y < 0 || X >= W || Y >= H || !D[(Y * W + X) * 4 + 3]; });
      if (edge) { out[i] = D[i] * 0.45; out[i + 1] = D[i + 1] * 0.45; out[i + 2] = D[i + 2] * 0.45; }
    }
    img.data.set(out); ctx.putImageData(img, 0, 0);
  }
  function tri(a, b, c, rgb, D, Z) {
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); if (Math.abs(area) < 1e-6) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + .5, py = y + .5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const d = w0 * a[2] + w1 * b[2] + w2 * c[2], k = y * W + x;
      if (d <= Z[k]) continue; Z[k] = d;
      D[k * 4] = rgb[0]; D[k * 4 + 1] = rgb[1]; D[k * 4 + 2] = rgb[2]; D[k * 4 + 3] = 255;
    }
  }

  /* ---------- flash and smoke (pixel puffs, drawn over the gun) ---------- */
  function ellPx(g, cx, cy, rx, ry, col) { g.fillStyle = col; for (let y = -ry; y <= ry; y++) { const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y / (ry + .5)) ** 2))); if (hw > 0) g.fillRect(Math.round(cx - hw), Math.round(cy + y), hw * 2, 1); } }
  function flash(g, x, y) { ellPx(g, x, y, 7, 6, '#ff9a1a'); ellPx(g, x, y, 5, 4, '#ffd23a'); ellPx(g, x, y, 2, 2, '#fff6c0'); }
  function smoke(g, x, y, k) {
    const a = [0, .95, .8, .5][k], r = [0, 8, 12, 15][k], rise = [0, 1, 5, 10][k];
    const puffs = [[0, 0, 1], [-.8, -.3, .8], [.7, -.5, .85], [-.2, -.9, .75], [.4, .3, .7], [-1, .2, .6], [1, .1, .6]];
    const cols = ['236,236,230', '214,214,208', '196,196,190'];
    puffs.forEach(([dx, dy, s], i) => ellPx(g, x + dx * r, y + dy * r - rise, Math.max(2, Math.round(r * s * .7)), Math.max(2, Math.round(r * s * .6)), `rgba(${cols[i % 3]},${(a * (0.85 + (i % 2) * .15)).toFixed(2)})`));
  }

  const cache = new Map();
  function get(nation, view, pose) {
    const vv = view === 'away' ? 'away' : 'toward';
    const key = `${nation}:${vv}:${pose}`; let c = cache.get(key); if (c) return c;
    c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const V = VIEW[vv];
    const recoil = { fire1: 4, fire2: 3, fire3: 2, fire4: 1 }[pose] || 0;
    const { m, muzzle } = gunMesh(nation, { recoil, wreck: pose === 'wreck' });
    render(m, V, g);
    const [mx, my] = project(muzzle, V);
    const ahead = vv === 'toward' ? [6, 3] : [-6, -3];
    if (pose === 'wreck') {
      // the lost wheel lies flat on the ground beside the gun
      const wx = vv === 'toward' ? V.ox + 20 : V.ox - 22, wy = V.oy - 4, col = PAL[nation].car;
      for (let a = 0; a < 48; a++) { const t = a / 48 * Math.PI * 2; g.fillStyle = PAL[nation].iron; g.fillRect(Math.round(wx + Math.cos(t) * 15), Math.round(wy + Math.sin(t) * 5), 1, 1); g.fillStyle = col; g.fillRect(Math.round(wx + Math.cos(t) * 13), Math.round(wy + Math.sin(t) * 4), 1, 1); }
      for (let k = 0; k < 6; k++) { if (k === 2 || k === 4) continue; const t = k / 6 * Math.PI * 2; for (let r = 2; r < 13; r++) { g.fillStyle = col; g.fillRect(Math.round(wx + Math.cos(t) * r), Math.round(wy + Math.sin(t) * r * 0.36), 1, 1); } }
      g.fillStyle = PAL[nation].iron; g.fillRect(wx - 2, wy - 1, 4, 2);
    }
    if (pose === 'fire1') flash(g, mx + ahead[0], my + ahead[1]);
    if (pose === 'fire2') smoke(g, mx + ahead[0] * 1.5, my + ahead[1], 1);
    if (pose === 'fire3') smoke(g, mx + ahead[0] * 1.8, my + ahead[1], 2);
    if (pose === 'fire4') smoke(g, mx + ahead[0] * 2, my + ahead[1], 3);
    cache.set(key, c); return c;
  }
  const ANIMS = {
    idle: { frames: ['idle'], fps: 1, loop: true },
    fire: { frames: ['fire1', 'fire2', 'fire2', 'fire3', 'fire3', 'fire4', 'fire4', 'idle'], fps: 7, loop: false },
    wreck: { frames: ['wreck'], fps: 1, loop: false }
  };
  const POSES = ['idle', 'fire1', 'fire2', 'fire3', 'fire4', 'wreck'];
  return { get, ANIMS, POSES, W, H };
})();
