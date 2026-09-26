/* =========================================================
   THE SASH

   Selecting a unit writes its name under it on the board, in a white
   copperplate hand, with its orders in a row beneath: Form square, Lay ambush,
   Charge, and History. No panel, no plate, nothing drawn behind the words: a
   layered dark shadow does the work, so the ground shows through. Chosen from
   the command-ribbon studies on ui-lab.html.

   IT DOES NOT REIMPLEMENT ANY RULE. The old panel's buttons (squareBtn,
   ambushBtn, chargeBtn) are still in the page, hidden, and still owned by
   ui-battle exactly as before: it decides whether each is shown, enabled and
   what it says. The sash mirrors them every frame and presses the real button
   when an order is chosen. So anything that already governs when a unit may
   form square or charge governs the sash too, with no second copy to drift.

   History opens a small slip under the orders with the unit's particulars
   (arm, side, how far it moves, its re-roll, its current state) and its
   regimental history. That is where the rest of the old panel's content lives.

   Positioned from the board canvas's on-screen box, which already includes any
   zoom and pan, so the lettering stays one size whatever the zoom, rather than
   shrinking with the board on a phone. It follows the unit's DRAWN position, so
   it rides along while the unit walks.
========================================================= */
import { COLS, ROWS, SIDE_LABEL, UNIT_TYPES, state } from './data-core.js';
import { canvas, getUnitVisualPos, sy } from './render-board.js';

export const SASH_UI = true;

let root = null, current = null, slipOpen = false, raf = null;

const ORDER_BUTTONS = ['squareBtn', 'ambushBtn', 'chargeBtn'];

function ensure(){
  if(root) return root;
  root = document.createElement('div');
  root.id = 'unitSash';
  root.setAttribute('role', 'group');
  root.innerHTML = '<div class="sash-name"></div><div class="sash-orders"></div><div class="sash-slip" hidden></div>';
  document.body.appendChild(root);
  document.body.classList.add('sash-ui');
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-order]');
    if(!btn) return;
    e.stopPropagation();
    const id = btn.dataset.order;
    if(id === 'history'){ slipOpen = !slipOpen; paint(true); return; }
    const real = document.getElementById(id);
    if(real && !real.disabled) real.click();
    paint(true);
  });
  return root;
}

function sentence(s){ return String(s || '').replace(/\s+/g, ' ').trim().replace(/^(.)(.*)$/, (m, a, b) => a.toUpperCase() + b.toLowerCase()); }

/* First letter only: sentence-casing the whole line lowercased "Britain". */
function capitalise(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

function particulars(u){
  const t = UNIT_TYPES[u.type];
  const bits = [`${t.label}, ${SIDE_LABEL[u.side]}`, `moves ${t.move}`];
  if(t.reroll) bits.push('re-roll');
  if(u.formation === 'square') bits.push('in square');
  if(u.hidden) bits.push('in ambush');
  if(u.turnOnly) bits.push('turning around');
  if(u.rallying) bits.push('rallying');
  if(u.charged) bits.push('has charged');
  return bits.join(', ');
}

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
  /* Always offered: the particulars that used to sit in the panel live in the
     slip, so every unit has something there even without a regimental history. */
  orders.push({ id: 'history', label: 'History' });
  const key = [u.id, u.formation, u.hidden, u.turnOnly, u.rallying, u.charged, slipOpen,
               ...orders.map(o => o.label)].join('|');
  if(force || key !== lastKey){
    lastKey = key;
    root.querySelector('.sash-name').textContent = u.historicalName || UNIT_TYPES[u.type].label;
    root.querySelector('.sash-orders').innerHTML = orders.map(o =>
      `<button type="button" data-order="${o.id}"${o.id === 'history' ? ` aria-expanded="${slipOpen}"` : ''}>${esc(o.label)}</button>`).join('');
    const slip = root.querySelector('.sash-slip');
    slip.hidden = !slipOpen;
    slip.innerHTML = slipOpen
      ? `<p class="sash-particulars">${esc(capitalise(particulars(u)))}.</p>${u.historicalBio ? `<p>${esc(u.historicalBio)}</p>` : ''}`
      : '';
  }
  place();
  root.classList.add('show');
}

/* Under the unit, centred on it; above it instead when the unit is on the
   bottom row, so the orders never fall off the board. Kept inside the viewport
   sideways. */
function place(){
  const u = current;
  const rect = canvas.getBoundingClientRect();
  const cw = rect.width / COLS, ch = rect.height / ROWS;
  const vp = getUnitVisualPos(u) || { x: u.x, y: u.y };
  const row = sy(vp.y);
  const cx = rect.left + (vp.x + 0.5) * cw;
  const w = root.offsetWidth || 200, h = root.offsetHeight || 60;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const underY = rect.top + (row + 1) * ch - 4, overY = rect.top + row * ch + 4;
  /* Below by default. Above when below would run off the screen and there is
     more room above, which is what an open History slip on a low unit needs;
     the bottom row always goes above. Otherwise clamped onto the screen. */
  const roomBelow = vh - underY, roomAbove = overY;
  const below = row < ROWS - 1 && (h <= roomBelow - 6 || roomBelow >= roomAbove);
  const left = Math.max(6, Math.min(vw - w - 6, cx - w / 2));
  let top = below ? underY : overY - h;
  top = Math.max(6, Math.min(vh - h - 6, top));
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  root.classList.toggle('above', !below);
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
  if(!u){ current = null; slipOpen = false; hide(); return; }
  if(!current || current.id !== u.id) slipOpen = false;
  current = u;
  paint(true);
  if(!raf) raf = requestAnimationFrame(loop);
}
