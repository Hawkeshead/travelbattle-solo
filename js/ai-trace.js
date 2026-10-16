/* =========================================================
   THE AI DECISION TRACE (read by the Spyglass overlay, js/spyglass.js)

   A record of what the AI was thinking, written as it decides: each
   Brigade's order for the turn, and for each unit every square it weighed,
   the score of each, and what made up the score of the square it chose and
   of the runner-up.

   READ-ONLY BY CONSTRUCTION. The AI only ever writes here; nothing in the
   AI reads any of it back. It lives in this module, not on `state`, so it is
   never saved, never in an undo snapshot, never sent to another phone and
   never in the match record. Writing it does no scoring of its own, draws no
   random numbers and changes no order of evaluation: it copies numbers the
   AI has already worked out. Off by default; the Spyglass switches it on,
   and tools/sim/spyglass-check.mjs proves a match plays identically either
   way.
========================================================= */
let capture = false;
let current = null;          // the turn being written: { turn, side, brigades: [], decisions: [] }
let last = null;             // the last complete turn, for drawing after the fact
const listeners = new Set();
let stats = { turns: 0, brigades: 0, decisions: 0, candidates: 0 };

export function setTraceCapture(on){ capture = !!on; if(!on){ current = null; } }
export const traceOn = () => capture;
export function onTrace(fn){ listeners.add(fn); return () => listeners.delete(fn); }
const tell = (kind, item) => { for(const fn of listeners){ try { fn(kind, item); } catch { /* a drawing fault never reaches the AI */ } } };

/* A new AI turn: the Brigades' orders. brigades: [{ id, brigadier:{x,y}|null,
   units:[ids], order, label, objective:{x,y}|null, timer:string|null, why }] */
export function traceTurn(turn, side, brigades){
  if(!capture) return;
  if(current) last = current;
  current = { turn, side, brigades, decisions: [] };
  stats.turns++; stats.brigades += brigades.length;
  tell('turn', current);
}
/* One unit's decision. d: { unitId, brigadeId, phase, from:{x,y}, to:{x,y}|null,
   action:'move'|'hold'|'square'|'ambush'|'charge'|'fire'|'fight'|'volley'|'marchOff',
   target:{x,y}|null, candidates:[{x,y,score}], chosen:{terms}, runnerUp:{x,y,score,terms}|null } */
export function traceDecision(d){
  if(!capture) return;
  if(!current) current = { turn: null, side: null, brigades: [], decisions: [] };
  current.decisions.push(d);
  stats.decisions++; stats.candidates += (d.candidates || []).length;
  tell('decision', d);
}
export const currentTrace = () => current;
export const lastTrace = () => last;
export const traceStats = () => ({ ...stats });
export function resetTrace(){ current = null; last = null; stats = { turns: 0, brigades: 0, decisions: 0, candidates: 0 }; }

/* THE PAUSE. In the Spyglass's Full view the AI waits after each unit for a
   tap. The overlay sets the gate; the AI's move loop passes its next step
   through it. With no gate (Off, Orders, the simulator, every online game)
   the step runs at once, exactly as before. A pause only delays the next
   unit: what it decides is already fixed by the board and the seed. */
let gate = null;
export function setStepGate(fn){ gate = fn || null; }
export function stepGate(next){ if(gate) gate(next); else next(); }
