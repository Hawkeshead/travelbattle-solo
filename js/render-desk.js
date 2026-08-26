/* =========================================================
   THE COMMANDER'S DESK
   Draws the walnut tabletop that sits behind every pre-battle menu.

   Procedural rather than an image asset for three reasons: it is a few
   hundred bytes instead of a few hundred kilobytes, it resizes to any
   viewport without stretching a fixed-ratio texture, and the grain can
   follow the long axis in either orientation without shipping two files.

   Drawn once on load and again on resize/orientation change — never per
   frame. Nothing here animates; the candle flicker is a CSS layer on top.
========================================================= */

// Planks always run along the long axis, so the desk reads correctly in
// portrait and landscape. Rather than duplicate the drawing logic for each
// case, we always draw into a portrait-shaped offscreen canvas and rotate it
// when blitting to a landscape target.
function drawGrain(x, w, h){
  x.fillStyle = '#432D14';
  x.fillRect(0, 0, w, h);

  // Three planks, each with its own subtle colour cast.
  const pw = w / 2.6;
  for(let p = 0; p < 3; p++){
    const g = x.createLinearGradient(p*pw, 0, (p+1)*pw, 0);
    g.addColorStop(0,   '#3B2711');
    g.addColorStop(.14, '#503617');
    g.addColorStop(.55, '#46300F');
    g.addColorStop(.86, '#523A1B');
    g.addColorStop(1,   '#33220E');
    x.fillStyle = g;
    x.fillRect(p*pw, 0, pw, h);
  }

  // Grain lines. Each is a shallow sine wave with a slow lateral drift, which
  // reads as timber far better than straight strokes or a repeating gradient.
  for(let i = 0; i < 520; i++){
    const y0 = Math.random()*h;
    const amp = 8 + Math.random()*46;
    const drift = (Math.random()-.5)*70;
    const dark = Math.random() > .42;
    x.strokeStyle = dark
      ? `rgba(28,18,8,${.05 + Math.random()*.2})`
      : `rgba(168,132,82,${.03 + Math.random()*.1})`;
    x.lineWidth = .6 + Math.random()*2.4;
    x.beginPath();
    x.moveTo(-20, y0);
    for(let sx = 0; sx <= w+20; sx += 44){
      x.quadraticCurveTo(
        sx+22, y0 + Math.sin((sx + i*30)/190)*amp,
        sx+44, y0 + Math.sin((sx+44 + i*30)/190)*amp + drift*(sx/w)
      );
    }
    x.stroke();
  }

  // Knots — concentric ellipses tightening to a dark core.
  [[w*.19, h*.24, 1], [w*.72, h*.66, .8], [w*.47, h*.86, .62]].forEach(([kx, ky, s])=>{
    for(let r = 42*s; r > 0; r -= 2.6){
      x.strokeStyle = `rgba(26,16,6,${.06 + (r/(42*s))*.16})`;
      x.lineWidth = 1.4;
      x.beginPath();
      x.ellipse(kx, ky, r*1.7, r, 0.35, 0, Math.PI*2);
      x.stroke();
    }
    x.fillStyle = 'rgba(22,13,5,.5)';
    x.beginPath();
    x.ellipse(kx, ky, 7*s, 4.4*s, .35, 0, Math.PI*2);
    x.fill();
  });

  // Plank seams: a dark gap with a lit edge on one side.
  for(let p = 1; p < 3; p++){
    x.strokeStyle = 'rgba(16,9,3,.62)';
    x.lineWidth = 3;
    x.beginPath(); x.moveTo(p*pw, 0); x.lineTo(p*pw, h); x.stroke();
    x.strokeStyle = 'rgba(186,150,96,.13)';
    x.lineWidth = 1.4;
    x.beginPath(); x.moveTo(p*pw+3, 0); x.lineTo(p*pw+3, h); x.stroke();
  }

  // Waxed sheen across the whole surface.
  const s = x.createLinearGradient(0, 0, w*.7, h);
  s.addColorStop(0,   'rgba(255,214,150,.11)');
  s.addColorStop(.42, 'rgba(255,214,150,.02)');
  s.addColorStop(1,   'rgba(0,0,0,.16)');
  x.fillStyle = s;
  x.fillRect(0, 0, w, h);
}

let resizeBound = false;

export function drawDesk(){
  const c = document.getElementById('deskCanvas');
  if(!c) return;
  const ctx = c.getContext('2d');
  // Cap the backing store so a desktop window does not allocate an enormous
  // canvas for what is a static, heavily textured background.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Sized from the viewport rather than the element. #overlay is fixed inset:0
  // so the two are identical when it is visible — but it is display:none at
  // boot, which makes offsetWidth 0 and would silently skip the first draw.
  const w = c.width  = Math.max(1, Math.round(window.innerWidth  * dpr));
  const h = c.height = Math.max(1, Math.round(window.innerHeight * dpr));
  if(w < 2 || h < 2) return;

  const landscape = w > h;
  const off = document.createElement('canvas');
  off.width  = landscape ? h : w;
  off.height = landscape ? w : h;
  drawGrain(off.getContext('2d'), off.width, off.height);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if(landscape){
    // Rotating 90deg maps source (a,b) to (w-b, a), so a portrait-space canvas
    // of width h and height w lands exactly on the landscape target.
    ctx.translate(w, 0);
    ctx.rotate(Math.PI/2);
    ctx.drawImage(off, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(off, 0, 0);
  }
}

// The folio backing is start-screen only, but #overlay and its .box are shared
// by every screen in the game — campaign.js, dice.js and engine-objectives.js
// all open the overlay directly without going through ui-menus. Relying on each
// of those to clean up would break the first time a new one was added, and it
// already broke once: Same Again goes straight to board setup, so the leather
// panel was still on the box when the dice roll opened.
//
// One observer instead of a call at every site: whenever the overlay closes,
// the box is reset. Nothing that opens it afterwards needs to know the folio
// exists.
function watchOverlayClose(){
  const overlay = document.getElementById('overlay');
  if(!overlay) return;
  let wasOpen = overlay.classList.contains('show');
  new MutationObserver(()=>{
    const open = overlay.classList.contains('show');
    if(wasOpen && !open){
      const box = overlay.querySelector('.box');
      if(box) box.classList.remove('as-folio');
    }
    wasOpen = open;
  }).observe(overlay, { attributes:true, attributeFilter:['class'] });
}

export function initDesk(){
  drawDesk();
  watchOverlayClose();
  if(resizeBound) return;
  resizeBound = true;
  let t = null;
  const redraw = ()=>{ clearTimeout(t); t = setTimeout(drawDesk, 120); };
  window.addEventListener('resize', redraw);
  window.addEventListener('orientationchange', redraw);
}
