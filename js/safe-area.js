/* =========================================================
   USING THE WHOLE SCREEN ON AN IPHONE

   Held sideways, an iPhone keeps a strip clear on BOTH sides of the screen for
   the camera, though the camera is only on one of them. The page was confined
   to the middle, so the board (20 squares across) was sized to that narrower
   width and left gaps above and below it.

   With viewport-fit=cover the game gets the whole screen and decides for
   itself. This file works out which side the camera is on and marks the page:
     island-left / island-right   landscape, camera on that side
   Then the stylesheet keeps only the camera side clear for the board and menus,
   gives the board the other strip, and puts the dials and the phase dispatch in
   the camera side's strip, above and below the camera, where most iPhone games
   put their controls. Measured on Matthew's phone (852x393 points, 59-point
   strips): squares 35 -> 38 points, about 18% more board, nothing over it.

   If there is no strip (desktop, most Android, portrait) or the camera side
   cannot be told, no class is set and the page keeps every side clear, which is
   exactly how it behaved before, so nothing can get worse.

   Test hook: window.__fcSafeArea = { left:59, right:59, top:0, bottom:21, angle:90 }
   before this runs, or setSafeAreaForTest(...), stands in for a real iPhone.
========================================================= */
const root = document.documentElement;

function inset(side){
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;padding-${side}:var(--sa-${side})`;
  document.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe)[`padding${side[0].toUpperCase()}${side.slice(1)}`]) || 0;
  probe.remove();
  return v;
}

/* iOS reports 90 when the phone is turned so its top (the camera) is on the
   left, and -90 when it is on the right. Newer browsers report the same through
   screen.orientation.angle, as 90 and 270. */
function cameraAngle(){
  const t = window.__fcSafeArea;
  if(t && typeof t.angle === 'number') return t.angle;
  if(typeof window.orientation === 'number') return window.orientation;
  if(screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return 0;
}

export function updateSafeArea(){
  const landscape = window.innerWidth > window.innerHeight;
  const left = inset('left'), right = inset('right');
  root.classList.remove('island-left', 'island-right');
  if(landscape && (left > 20 || right > 20)){
    const a = cameraAngle();
    if(a === 90) root.classList.add('island-left');
    else if(a === -90 || a === 270) root.classList.add('island-right');
  }
}

export function setSafeAreaForTest(t){
  window.__fcSafeArea = t;
  for(const side of ['top', 'right', 'bottom', 'left'])
    root.style.setProperty(`--sa-${side}`, `${(t && t[side]) || 0}px`);
  updateSafeArea();
}

export function initSafeArea(){
  if(window.__fcSafeArea) setSafeAreaForTest(window.__fcSafeArea);
  updateSafeArea();
  window.addEventListener('resize', updateSafeArea);
  window.addEventListener('orientationchange', () => setTimeout(updateSafeArea, 250));
}
