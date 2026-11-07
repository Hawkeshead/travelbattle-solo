/* =========================================================
   ISO LAB: THE CAMERA (prototype only)

   An orbit camera over the board: a target on the ground, a yaw, a pitch
   (clamped between a low angle and near top-down) and a distance.
   Touch: one finger pans, two fingers pinch to zoom, twist to turn and drag
   up or down together to tilt. Mouse: drag pans, wheel zooms, right-drag or
   shift-drag orbits. A narrow perspective keeps the isometric feel; an
   orthographic camera can be switched in.
========================================================= */
/* three.js is loaded on demand (js/board3d.js loadThree), so it is read when first used, not when this module loads. */
let THREE = globalThis.THREE;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const PITCH_MIN = 25 * Math.PI / 180, PITCH_MAX = 80 * Math.PI / 180;
const FOV = 28;

export class OrbitRig {
  constructor(canvas, cols, rows){
    THREE = globalThis.THREE;
    this.canvas = canvas;
    this.cols = cols; this.rows = rows;
    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 200);
    this.orthographic = false;
    this.reset();
    this.pointers = new Map();
    this.bind();
  }
  get camera(){ return this.orthographic ? this.ortho : this.persp; }
  reset(){
    this.target = new THREE.Vector3(this.cols / 2, 0, this.rows / 2);
    // a corridor battle (10 wide, 20 deep, France at the top) is seen from its side, as the game shows it
    this.yaw = this.defaultYaw != null ? this.defaultYaw : this.rows > this.cols ? -Math.PI / 2 : 0;
    this.pitch = 52 * Math.PI / 180;
    this.dist = Math.max(this.cols, this.rows) * 1.25 + 4;
    this.distMin = 3; this.distMax = Math.max(this.cols, this.rows) * 3;
  }
  resize(w, h){
    this.aspect = w / h;
    this.persp.aspect = this.aspect; this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }
  updateOrtho(){
    // the same framing as the perspective camera at this distance
    const half = Math.tan(FOV / 2 * Math.PI / 180) * this.dist;
    this.ortho.left = -half * this.aspect; this.ortho.right = half * this.aspect;
    this.ortho.top = half; this.ortho.bottom = -half;
    this.ortho.updateProjectionMatrix();
  }
  /* The camera's place for the rig's yaw, pitch and distance; yaw 0 looks north (towards y = 0) from the south edge. */
  apply(){
    const cam = this.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const off = new THREE.Vector3(Math.sin(this.yaw) * cp, sp, Math.cos(this.yaw) * cp).multiplyScalar(this.dist);
    cam.position.copy(this.target).add(off);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    if(this.orthographic) this.updateOrtho();
    cam.updateMatrixWorld();
  }
  /* Ground-plane directions for panning: right and forward as seen on screen. */
  groundAxes(){
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return { right, fwd };
  }
  pan(dxPx, dyPx){
    const h = this.canvas.clientHeight || 1;
    // squares per screen pixel at the target's depth
    const scale = (2 * Math.tan(FOV / 2 * Math.PI / 180) * this.dist) / h;
    const { right, fwd } = this.groundAxes();
    this.target.addScaledVector(right, -dxPx * scale).addScaledVector(fwd, dyPx * scale);
    const m = 3;
    this.target.x = clamp(this.target.x, -m, this.cols + m);
    this.target.z = clamp(this.target.z, -m, this.rows + m);
  }
  zoomBy(f){ this.dist = clamp(this.dist / f, this.distMin, this.distMax); }
  tiltTo(deg){ this.pitch = clamp(deg * Math.PI / 180, PITCH_MIN, PITCH_MAX); }
  bind(){
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      /* A finger something else has claimed (a unit dragged during deployment) is not a camera gesture. */
      if(this.ignore && this.ignore(e)) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* a synthetic event */ } this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), b: e.button, shift: e.shiftKey, two: this.pointers.size > 0 }); this.gesture = null; });
    /* A tap: one finger, down and up within 350 ms, moved less than 8 px (onTap is set by the page). */
    const end = e => {
      const p = this.pointers.get(e.pointerId);
      if(p && e.type === 'pointerup' && !p.two && this.pointers.size === 1 && performance.now() - p.t0 < 350 && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 8 && this.onTap) this.onTap(e.clientX, e.clientY);
      this.pointers.delete(e.pointerId); this.gesture = null;
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end); c.addEventListener('pointerleave', e => { if(e.pointerType === 'mouse') end(e); });
    c.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId); if(!p) return;
      const pts = [...this.pointers.values()];
      if(pts.length === 1){
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if(p.b === 2 || p.shift){ this.yaw -= dx * 0.006; this.pitch = clamp(this.pitch + dy * 0.004, PITCH_MIN, PITCH_MAX); }
        else this.pan(dx, dy);
        p.x = e.clientX; p.y = e.clientY;
      } else if(pts.length >= 2){
        const [a, b] = pts;
        const before = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(a.y - b.y, a.x - b.x), cy: (a.y + b.y) / 2, cx: (a.x + b.x) / 2 };
        p.x = e.clientX; p.y = e.clientY;
        const after = { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(a.y - b.y, a.x - b.x), cy: (a.y + b.y) / 2, cx: (a.x + b.x) / 2 };
        if(before.d > 10 && after.d > 10) this.zoomBy(after.d / before.d);
        let da = after.ang - before.ang; if(da > Math.PI) da -= 2 * Math.PI; if(da < -Math.PI) da += 2 * Math.PI;
        this.yaw -= da;
        // the two fingers moving up or down together: tilt
        this.pitch = clamp(this.pitch - (after.cy - before.cy) * 0.004, PITCH_MIN, PITCH_MAX);
        this.pan((after.cx - before.cx) * 0.5, 0);
      }
      this.changed = true;
      if(this.onUserMove && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) this.onUserMove();
    });
    c.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0015)); this.changed = true; if(this.onUserMove) this.onUserMove(); }, { passive: false });
    c.addEventListener('dblclick', () => { this.reset(); this.changed = true; if(this.onUserMove) this.onUserMove(); });
  }
}
