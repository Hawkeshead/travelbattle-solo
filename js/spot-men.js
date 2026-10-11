/* =========================================================
   SPOT MEN (Matthew, 11 Oct 2026)

   A button on a Brigadier's card that shows his Brigade's command chain on
   the board, so players can see which of his units are in command (the
   command rule: next to the Brigadier, diagonals included, or next to a unit
   of his Brigade that already is; engine-rules movableUnitsForSide).

   What it draws, on the ground under the troops (render-board calls
   drawSpotMen after the terrain and move highlights, before the units):
   - a line from the Brigadier through every unit in command, branching the
     way command spreads (each unit hangs off the neighbour that links it
     back), with a node on each connected unit, drawn outward from the
     Brigadier over half a second when switched on;
   - a glow on every unit of his Brigade that is OUT of command, with a short
     broken stub pointing back towards the chain and how many squares it is
     from rejoining;
   - a small chain mark on weak links: units that are the only link holding
     others in command;
   - "N of M in command" under the Brigadier;
   - while one of his units is selected to move, its reachable squares tinted
     green (everyone stays in command) or amber (the move cuts someone off).
   Silver for British chains, gold for French. Visual only: no rules, no
   state that is saved, synced or replayed.
========================================================= */
import { state } from './data-core.js';
import { isAdjacent } from './engine-rules.js';

let spotId = null;          // the Brigadier whose chain is shown, or null
let spotStart = 0;          // when it was switched on (for the draw-in)
const DRAW_IN_MS = 500;

export const spotMenFor = () => spotId;
export function toggleSpotMen(brigadierId, redraw){
  spotId = spotId === brigadierId ? null : brigadierId;
  spotStart = performance.now();
  if(spotId && redraw){
    // Keep drawing while the line grows (the board does not repaint on its own when nothing moves).
    const step = () => { redraw(); if(spotId && performance.now() - spotStart < DRAW_IN_MS + 50) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  } else if(redraw) redraw();
  return spotId;
}
export function clearSpotMen(){ spotId = null; }

/* The command tree of one Brigadier's Brigade, with every unit placed where
   `moved` says (for the move preview), else where it stands. */
export function commandTree(brig, moved){
  const at = u => (moved && moved.id === u.id ? { x: moved.x, y: moved.y, id: u.id } : u);
  const group = state.units.filter(u => !u.removed && u.side === brig.side && u.brigadeId === brig.brigadeId);
  const parent = new Map([[brig.id, null]]), depth = new Map([[brig.id, 0]]), order = [brig];
  for(let i = 0; i < order.length; i++){
    const a = order[i];
    for(const u of group){
      if(parent.has(u.id)) continue;
      if(isAdjacent(at(a), at(u))){ parent.set(u.id, a); depth.set(u.id, depth.get(a.id) + 1); order.push(u); }
    }
  }
  const linked = order.filter(u => u !== brig);
  const cut = group.filter(u => !parent.has(u.id));
  return { group, parent, depth, linked, cut, at };
}
/* Units that are the only link holding others in command. */
function weakLinks(brig, tree){
  return tree.linked.filter(w => {
    const seen = new Set([brig.id]), q = [brig];
    while(q.length){
      const a = q.shift();
      for(const u of tree.group){
        if(u.id === w.id || seen.has(u.id)) continue;
        if(isAdjacent(a, u)){ seen.add(u.id); q.push(u); }
      }
    }
    return tree.linked.some(o => o.id !== w.id && !seen.has(o.id));
  });
}

const COLOURS = {
  red:  { line: '#e9edf2', lineDk: 'rgba(30,34,42,0.6)', node: ['#ffffff', '#9aa3ad'], glow: [230, 236, 244], text: '#f4f6fa' },   // British: silver
  blue: { line: '#f3cf6a', lineDk: 'rgba(40,24,6,0.6)',  node: ['#fff1b8', '#c99a2e'], glow: [255, 214, 110], text: '#fff4d6' },   // French: gold
};

/* Draws the chain. P(x, y) -> the square's centre in canvas pixels; cell is
   one square's size in canvas pixels. moveCells: the selected unit's move
   highlights ({x, y, kind}), selected: the selected unit. */
/* Labels and chain marks are drawn in a second pass ABOVE the troops
   (drawSpotMenOverlay, after the units), so figures never hide the words. */
let overlay = [];
export function drawSpotMenOverlay(ctx){
  for(const f of overlay) f(ctx);
  overlay = [];
}
export function drawSpotMen(ctx, cell, P, moveCells, selected){
  overlay = [];
  if(!spotId) return;
  const brig = state.units.find(u => u.id === spotId && !u.removed);
  if(!brig){ spotId = null; return; }
  const tree = commandTree(brig);
  const col = COLOURS[brig.side] || COLOURS.blue;
  const foot = u => { const p = P(u.x, u.y); return { x: p.x, y: p.y + cell * 0.18 }; };
  const grow = Math.min(1, (performance.now() - spotStart) / DRAW_IN_MS);
  const maxDepth = Math.max(1, ...tree.linked.map(u => tree.depth.get(u.id)));
  const shown = u => tree.depth.get(u.id) <= grow * maxDepth + 0.001;
  ctx.save();

  // The move preview: green keeps everyone in command, amber cuts someone off.
  if(selected && selected.brigadeId === brig.brigadeId && selected.side === brig.side && moveCells && moveCells.length){
    const inNow = new Set([brig.id, ...tree.linked.map(u => u.id)]);
    for(const c of moveCells){
      if(c.kind && c.kind !== 'move') continue;
      const t2 = commandTree(brig, { id: selected.id, x: c.x, y: c.y });
      const in2 = new Set([brig.id, ...t2.linked.map(u => u.id)]);
      const ok = (selected.type === 'BRIGADIER' || in2.has(selected.id)) && [...inNow].every(id => in2.has(id) || id === selected.id) ;
      const p = P(c.x, c.y);
      ctx.fillStyle = ok ? 'rgba(90,200,110,0.30)' : 'rgba(240,160,40,0.34)';
      ctx.strokeStyle = ok ? 'rgba(120,230,140,0.9)' : 'rgba(250,180,60,0.95)';
      ctx.lineWidth = Math.max(1.5, cell * 0.03);
      ctx.beginPath(); ctx.rect(p.x - cell * 0.44, p.y - cell * 0.44, cell * 0.88, cell * 0.88); ctx.fill(); ctx.stroke();
    }
  }

  // Out of command: the glow, a broken stub back towards the chain, the distance.
  const [gr, gg, gb] = col.glow;
  for(const u of tree.cut){
    const p = foot(u);
    const g = ctx.createRadialGradient(p.x, p.y, cell * 0.05, p.x, p.y, cell * 0.62);
    g.addColorStop(0, `rgba(${gr},${gg},${gb},0.85)`); g.addColorStop(0.55, `rgba(${gr},${gg},${gb},0.42)`); g.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y, cell * 0.62, cell * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    let best = brig, bd = Infinity;
    for(const o of [brig, ...tree.linked]){ const dd = Math.max(Math.abs(o.x - u.x), Math.abs(o.y - u.y)); if(dd < bd){ bd = dd; best = o; } }
    const q = foot(best), dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
    ctx.strokeStyle = col.line; ctx.lineWidth = Math.max(1.5, cell * 0.035); ctx.setLineDash([cell * 0.07, cell * 0.08]);
    ctx.beginPath(); ctx.moveTo(p.x + dx / L * cell * 0.42, p.y + dy / L * cell * 0.28); ctx.lineTo(p.x + dx / L * cell * 0.95, p.y + dy / L * cell * 0.7); ctx.stroke();
    ctx.setLineDash([]);
    const steps = Math.max(1, bd - 1);
    overlay.push(c => label(c, `out of command: ${steps} square${steps === 1 ? '' : 's'} to rejoin`, p.x, p.y + cell * 0.58, cell * 0.17, col.text, false));
  }

  // The chain: lines from each unit to the one that links it back, then the nodes.
  ctx.lineCap = 'round';
  for(const [w, s] of [[cell * 0.10, col.lineDk], [cell * 0.045, col.line]]){
    ctx.strokeStyle = s; ctx.lineWidth = Math.max(1.5, w);
    for(const u of tree.linked){
      const d = tree.depth.get(u.id);
      const frac = Math.max(0, Math.min(1, grow * maxDepth - (d - 1)));
      if(frac <= 0) continue;
      const a = foot(tree.parent.get(u.id)), c = foot(u);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (c.x - a.x) * frac, a.y + (c.y - a.y) * frac); ctx.stroke();
    }
  }
  for(const u of [brig, ...tree.linked]){
    if(u !== brig && !shown(u)) continue;
    const p = foot(u), R = (u === brig ? 0.12 : 0.085) * cell;
    ctx.fillStyle = col.lineDk; ctx.beginPath(); ctx.arc(p.x, p.y, R + cell * 0.025, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(p.x - R * 0.3, p.y - R * 0.3, 1, p.x, p.y, R);
    g.addColorStop(0, col.node[0]); g.addColorStop(1, col.node[1]);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
  }

  // Weak links: a small chain mark beside the node.
  if(grow >= 1) for(const u of weakLinks(brig, tree)){
    const p = foot(u), x = p.x + cell * 0.30, y = p.y + cell * 0.08, rx = cell * 0.075, ry = cell * 0.048;
    overlay.push(c => {
      for(const [w, s] of [[Math.max(2, cell * 0.04), col.lineDk], [Math.max(1.2, cell * 0.022), col.line]]){
        c.lineWidth = w; c.strokeStyle = s;
        for(const off of [-rx * 0.7, rx * 0.7]){ c.beginPath(); c.ellipse(x + off, y, rx, ry, 0.6, 0, Math.PI * 2); c.stroke(); }
      }
    });
  }

  // The count, under the Brigadier.
  const total = tree.linked.length + tree.cut.length;
  const bp = P(brig.x, brig.y);
  // Under the Brigadier, or above him when he stands on the bottom row of the view.
  const below = bp.y + cell * 0.95 < ctx.canvas.height;
  overlay.push(c => label(c, `${tree.linked.length} of ${total} in command`, bp.x, bp.y + (below ? cell * 0.72 : -cell * 0.55), cell * 0.24, col.text, true));
  ctx.restore();
}
function label(ctx, text, x, y, size, colour, serif){
  ctx.font = serif ? `italic 700 ${size}px 'Cormorant Garamond', Georgia, serif` : `600 ${size}px Inter, sans-serif`;
  ctx.textAlign = 'center'; ctx.lineJoin = 'round';
  // Kept on the board at its edges (a Brigadier in a corner square).
  const half = ctx.measureText(text).width / 2 + 4;
  x = Math.max(half, Math.min(ctx.canvas.width - half, x));
  ctx.lineWidth = Math.max(2, size * 0.28); ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = colour; ctx.fillText(text, x, y);
}
