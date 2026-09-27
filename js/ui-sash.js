/* =========================================================
   THE FAN (was the sash)

   Selecting a unit writes its name beside it on the board in a white
   copperplate hand, with its orders as small paper slips splayed on a slight
   arc beneath the name: Form square, Lay ambush, Charge. Only orders the unit
   can actually give right now appear; a unit with none shows just its name.
   The fan opens away from the nearer side of the board, so it never falls off
   the map. Chosen from the command-ribbon studies on ui-lab.html (the "Fan"
   style), in the sash's font.

   History and the particulars slip were removed at Matthew's request, to keep
   the board to gameplay only; the unit archive is untouched and can return.

   IT DOES NOT REIMPLEMENT ANY RULE. The old panel's buttons (squareBtn,
   ambushBtn, chargeBtn) are still in the page, hidden, and still owned by
   ui-battle exactly as before: it decides whether each is shown, enabled and
   what it says. The fan mirrors them every frame and presses the real button,
   so whatever governs when a unit may form square or charge governs the fan.

   Positioned from the board canvas's on-screen box, which includes zoom and
   pan, so the lettering stays one size at any zoom, and following the unit's
   DRAWN position so it rides along while the unit walks.
========================================================= */
import { COLS, ROWS, SIDE_COLOR, UNIT_TYPES, state } from './data-core.js';
import { canvas, getUnitVisualPos, sy } from './render-board.js';

export const SASH_UI = true;

let root = null, current = null, raf = null;

const ORDER_BUTTONS = ['squareBtn', 'ambushBtn', 'chargeBtn'];

function ensure(){
  if(root) return root;
  root = document.createElement('div');
  root.id = 'unitSash';
  root.setAttribute('role', 'group');
  root.innerHTML = '<div class="sash-name"></div><div class="sash-orders"></div>';
  document.body.appendChild(root);
  document.body.classList.add('sash-ui');
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-order]');
    if(!btn) return;
    e.stopPropagation();
    const real = document.getElementById(btn.dataset.order);
    if(real && !real.disabled) real.click();
    paint(true);
  });
  return root;
}

function sentence(s){ return String(s || '').replace(/\s+/g, ' ').trim().replace(/^(.)(.*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase()); }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }

/* Rebuilds the words only when they change, so a unit that is simply walking
   costs a reposition and nothing else. */
let lastKey = '';
function paint(force){
  const u = current;
  if(!u || u.removed || state.phase === 'deploy' || state.gameOver){ hide(); return; }
  const orders = [];
  for(const id of ORDER_BUTTONS){
    const b = document.getElementById(id);
    if(!b || b.style.display === 'none' || b.disabled) continue;
    orders.push({ id, label: sentence(b.textContent) });
  }
  const opensLeft = openLeft(u);
  const key = [u.id, opensLeft, ...orders.map(o => o.label)].join('|');
  if(force || key !== lastKey){
    lastKey = key;
    root.style.setProperty('--side', SIDE_COLOR[u.side]);
    root.classList.toggle('left', opensLeft);
    root.querySelector('.sash-name').textContent = u.historicalName || UNIT_TYPES[u.type].label;
    const n = orders.length;
    /* Splayed like a hand of orders: each slip turned a few degrees about the
       edge nearest the unit, the middle one straight. */
    root.querySelector('.sash-orders').innerHTML = orders.map((o, i) =>
      `<button type="button" data-order="${o.id}" style="--r:${((i - (n - 1) / 2) * 6 * (opensLeft ? -1 : 1)).toFixed(1)}deg">${esc(o.label)}</button>`).join('');
  }
  place(opensLeft);
  root.classList.add('show');
}

/* Opens to the right of the unit, or to the left when the unit is in the right
   half of the board, the same rule the old panel used for its side. */
function openLeft(u){
  const vp = getUnitVisualPos(u) || { x: u.x };
  return vp.x >= COLS / 2;
}

function place(opensLeft){
  const u = current;
  const rect = canvas.getBoundingClientRect();
  const cw = rect.width / COLS, ch = rect.height / ROWS;
  const vp = getUnitVisualPos(u) || { x: u.x, y: u.y };
  const row = sy(vp.y);
  const w = root.offsetWidth || 160, h = root.offsetHeight || 60;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = opensLeft ? rect.left + vp.x * cw - w - 2 : rect.left + (vp.x + 1) * cw + 2;
  let top = rect.top + row * ch - 4;
  left = Math.max(6, Math.min(vw - w - 6, left));
  top = Math.max(6, Math.min(vh - h - 6, top));
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

function loop(){
  raf = null;
  if(!current) return;
  paint(false);
  raf = requestAnimationFrame(loop);
}

function hide(){
  if(root) root.classList.remove('show');
  if(raf){ cancelAnimationFrame(raf); raf = null; }
}

/* Called from renderUnitInfo whenever the selection changes. */
export function showSash(u){
  if(!SASH_UI) return;
  ensure();
  if(!u){ current = null; hide(); return; }
  current = u;
  paint(true);
  if(!raf) raf = requestAnimationFrame(loop);
}
