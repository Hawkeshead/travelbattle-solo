/* =========================================================
   MATCH TELEMETRY: THE RECORDER (build spec, 2 Oct 2026, sections 2.2-2.3)

   Holds the current match's record in memory and lets the game append to it as
   things happen. No DOM and no network, so the Node simulator runs it exactly
   as the browser does; sending is the write path's job (section 3).

   THE RULES IT KEEPS (spec principles 1 and 4)
   - It never calls the game's dice or Math.random, never changes a game object,
     and never throws into play: every entry point is wrapped, and a failure is
     recorded as a fault (derived.recorder_faults) instead of escaping.
   - It copies, never references: payloads are JSON-cloned on the way in, so a
     unit changing later cannot change what was recorded.
   - The same seed with the recorder on and off gives the same match and the
     same text export (tools/telemetry/recorder-check.mjs is that gate).

   WHERE THE EVENTS COME FROM
   Almost every rules event already passes through engine-state's logReplay at
   the exact moment it resolves, for human and AI moves alike, because the
   replay player and the floating labels are built from it. So the recorder
   takes those there (fromReplay below), in one place, rather than adding a
   second call beside each of a dozen executors. The few things logReplay never
   sees are hooked directly: the match start and deployment (ui-battle), the
   AI's plan, combo, finishing and per-unit decision lines (ai-strategy, at the
   sites that write the text lines today) and the match end (engine-objectives).
========================================================= */
import { state } from '../data-core.js';

export const RECORDER_SCHEMA_VERSION = 1;

let enabled = true;
let rec = null;
let t0 = 0;                     // Date.now() at start
let hiddenMs = 0, hiddenSince = 0;
let faults = 0;
const lastConnected = new Map();   // unit id -> connected, for chain_break
let lastTurnSeen = null, lastSide = null;

/* The simulator's on/off switch for the identical-match gate. */
export function setRecorderEnabled(on){ enabled = !!on; if(!enabled) rec = null; }
export const recorderEnabled = () => enabled;
export const currentRecord = () => rec;

const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const now = () => Date.now();
const activeMs = () => Math.max(0, now() - t0 - hiddenMs - (hiddenSince ? now() - hiddenSince : 0));
const unitRef = id => {
  const u = (state.units || []).find(x => x.id === id);
  return u ? { id: u.id, type: u.type, brigade: u.brigadeId } : (id != null ? { id, type: null, brigade: null } : null);
};

function guard(fn){
  return (...args) => {
    if(!enabled) return undefined;
    try { return fn(...args); } catch(e){ fault(e); return undefined; }
  };
}
function fault(e){
  faults += 1;
  try {
    if(rec){
      rec.derived.recorder_faults = faults;
      (rec.derived.fault_notes = rec.derived.fault_notes || []).push(String(e && e.message || e).slice(0, 200));
    }
  } catch(_e){ /* nothing more to be done */ }
}

/* Who is playing a side: 'ai' or 'human'. Spectate (and the simulator) is AI
   against AI; versus the AI, the AI's side; online, everyone is human. */
function actorFor(side){
  if(state.spectate) return 'ai';
  if(state.mode === 'ai') return side === state.aiSide ? 'ai' : 'human';
  return 'human';
}
function modeName(){
  if(state.mode === 'group' || state.boardMode === 'grand') return 'online_group';
  if(state.mode === 'online') return 'online_1v1';
  return 'ai';
}

/* ---------- match start (ui-battle, as the battle begins) ---------- */
export const recStart = guard(meta => {
  t0 = now(); hiddenMs = 0; hiddenSince = 0; faults = 0;
  lastConnected.clear(); lastTurnSeen = null; lastSide = null;
  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : null;
  const sides = [...new Set((state.units || []).map(u => u.side))];
  rec = {
    schemaVersion: RECORDER_SCHEMA_VERSION,
    matchUid: (meta && meta.onlineMatchId) || uuid,
    seed: meta && meta.seed != null ? String(meta.seed) : null,
    mode: modeName(),
    onlineMatchId: (meta && meta.onlineMatchId) || null,
    build: { version: meta && meta.build ? meta.build.version : null, commit: meta && meta.build ? meta.build.commit : null, aiWeightsHash: null },
    ai: state.mode === 'ai' ? { baseline: (meta && meta.aiBaseline) || 'main', difficulty: state.aiDifficulty || null } : null,
    players: sides.map(side => ({ seat: state.mode === 'ai' ? (actorFor(side) === 'ai' ? side : 'solo') : side, side, name: (meta && meta.names && meta.names[side]) || null, user_id: null, actor: actorFor(side) })),
    firstDeployer: (meta && meta.firstDeployer) || null,
    counterPick: meta && meta.counterPick != null ? !!meta.counterPick : null,
    startedAt: new Date(t0).toISOString(),
    hiddenMs: 0, endedAt: null, endReason: null, winner: null, isComplete: false, turns: null,
    events: [], snapshots: [], terms: [], derived: {}, text: { exportText: null, moveLog: null },
  };
  // The deployment, as it stands when the battle begins: one event per unit.
  (state.units || []).forEach((u, i) => {
    pushEvent('deploy', u.side, u.id, { unit: unitRef(u.id), tile: { x: u.x, y: u.y }, formation: u.formation || 'line', order: i }, 'deploy');
  });
});

function pushEvent(type, side, unitId, payload, phaseOverride){
  if(!rec) return;
  rec.events.push({
    seq: rec.events.length,
    turn: state.turnNumber || 0,
    phase: phaseOverride || phaseName(state.phase),
    side: side || null,
    seat: side || null,
    actor: side ? actorFor(side) : null,
    type,
    unitId: unitId != null ? String(unitId) : null,
    tMs: activeMs(),
    payload: clone(payload) || {},
  });
}
const phaseName = p => ({ move: 'move', fire: 'artillery', fight: 'fight', deploy: 'deploy', orientation: 'deploy' }[p] || p || null);

/* ---------- the game's own event stream (engine-state logReplay) ---------- */
export const recFromReplay = guard(ev => {
  if(!rec || !ev) return;
  switch(ev.type){
    case 'turnStart': {
      if(lastTurnSeen != null){
        pushEvent('turn_end', lastSide, null, { wall_ts: now() });
        snapshotNow(lastTurnSeen);
      }
      lastTurnSeen = state.turnNumber; lastSide = ev.side || null;
      pushEvent('turn_start', ev.side, null, { wall_ts: now(), army: ev.army || null });
      return;
    }
    case 'move': {
      pushEvent('move', ev.side, ev.unitId, {
        unit: unitRef(ev.unitId), from: ev.from, to: ev.to, kind: ev.kind || null,
        path_len: ev.from && ev.to ? Math.abs(ev.to.x - ev.from.x) + Math.abs(ev.to.y - ev.from.y) : null,
        road_used: null, brig_in_range_end: ev.connected != null ? !!ev.connected : null,
        formation: ev.formation || null, status: ev.status || null,
      });
      if(ev.connected != null){
        const was = lastConnected.has(ev.unitId) ? lastConnected.get(ev.unitId) : true;
        if(was && !ev.connected) pushEvent('chain_break', ev.side, ev.unitId, { brigade: ev.brigadeId, units_disconnected: [ev.unitId] });
        lastConnected.set(ev.unitId, !!ev.connected);
      }
      return;
    }
    case 'formation':
      pushEvent('formation', ev.side, ev.unitId, { unit: unitRef(ev.unitId), tile: { x: ev.x, y: ev.y }, from: ev.to === 'square' ? 'line' : 'square', to: ev.to, by: ev.by || null });
      return;
    case 'fight': {
      const payload = Object.assign({}, ev);
      delete payload.type; delete payload.turn; delete payload.phase;
      payload.attacker = unitRef(ev.attackerId); payload.defender = unitRef(ev.defenderId);
      pushEvent('fight', ev.attackerSide, ev.attackerId, payload);
      return;
    }
    case 'fire': {
      const payload = Object.assign({}, ev);
      delete payload.type; delete payload.turn; delete payload.phase;
      if(ev.volley) pushEvent('volley', ev.shooterSide || null, ev.shooterId, Object.assign(payload, { shooter: unitRef(ev.shooterId), target: unitRef(ev.targetId) }));
      else pushEvent('artillery', ev.gunSide || null, ev.gunId, Object.assign(payload, { battery: unitRef(ev.gunId), target: unitRef(ev.targetId) }));
      return;
    }
    case 'rally':
      pushEvent('rally', ev.side, ev.unitId, {
        unit: unitRef(ev.unitId), threshold: ev.threshold, roll: ev.roll, result: ev.success ? 'rallied' : 'failed',
        brig_in_range: !!ev.brigadierInRange, leadership_available: !!ev.leadershipAvailable, note: ev.note || null,
      });
      return;
    case 'leadership':
      pushEvent('leadership', ev.side, ev.unitId, { brigadier: unitRef(ev.brigadierId), unit: unitRef(ev.unitId), purpose: 'save', result: 'spent' });
      return;
    case 'ambush':
      if(ev.phase === 'set' || ev.phase === 'sprung')
        pushEvent(ev.phase === 'set' ? 'ambush_set' : 'ambush_sprung', ev.side, ev.unitId,
          { unit: unitRef(ev.unitId), tile: { x: ev.x, y: ev.y }, trigger_unit: ev.targetId != null ? unitRef(ev.targetId) : null, by: ev.by || null });
      return;
    case 'status':
      if(ev.newStatus === 'Destroyed' || ev.newStatus === 'Lost')
        pushEvent('destroyed', ev.side, ev.unitId, { unit: unitRef(ev.unitId), cause: causeOf(ev), reason: ev.reason || null });
      return;
    default: return;
  }
});
/* The five causes in the spec, from the reason the game logged. */
function causeOf(ev){
  if(ev.newStatus === 'Lost') return 'failed_rally';
  const r = String(ev.reason || '').toLowerCase();
  if(/volley|musket/.test(r)) return 'volley';
  if(/artiller|gun|canister|shot/.test(r)) return 'artillery';
  if(/column/.test(r)) return 'column_break';
  if(/rally/.test(r)) return 'failed_rally';
  return 'combat';
}

/* The live AI tuning, identified (spec 2.1): SHA-256 of the canonical JSON of
   every numeric constant ai-strategy exports, plus any per-side overrides in
   state.aiConfig. Asynchronous (crypto.subtle), and touches nothing else. */
export const recWeightsHash = guard(aiModule => {
  if(!rec || !aiModule || typeof crypto === 'undefined' || !crypto.subtle) return;
  const mine = rec;
  const weights = {};
  for(const k of Object.keys(aiModule).sort()) if(typeof aiModule[k] === 'number') weights[k] = aiModule[k];
  const canon = JSON.stringify({ weights, overrides: sortKeys(state.aiConfig || {}) });
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)).then(buf => {
    if(mine) mine.build.aiWeightsHash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }, () => {});
});
function sortKeys(o){
  if(Array.isArray(o)) return o.map(sortKeys);
  if(o && typeof o === 'object') return Object.keys(o).sort().reduce((m, k) => (m[k] = sortKeys(o[k]), m), {});
  return o;
}

/* ---------- the AI's own lines (ai-strategy) ---------- */
export const recAi = guard((kind, side, payload) => {
  if(!rec) return;
  if(kind === 'ai_decision' && payload) payload = slimDecision(payload);
  pushEvent(kind, side, payload && payload.unitId != null ? payload.unitId : null, payload);
});
/* An AI unit decision as the spec has it: {unit, mission, chosen, terms,
   runner_up_gap}. terms is the chosen option's per-term scores (to three
   places), and the runner-up gap is how far ahead of the next-best option it
   was. The full list of alternatives stays in the AI move log text. */
const r3 = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
function slimDecision(p){
  const d = p.decision || null;
  const terms = d && d.chosen && d.chosen.parts ? Object.fromEntries(Object.entries(d.chosen.parts).map(([k, v]) => [k, r3(v)])) : null;
  const alt = d && d.alternatives && d.alternatives.length ? d.alternatives[0] : null;
  return {
    unitId: p.unitId, unit: p.unit, mission: p.mission, chosen: p.chosen, to: p.to || null,
    total: d && d.chosen ? r3(d.chosen.total) : null,
    terms,
    runner_up_gap: d && d.chosen && alt ? r3(d.chosen.total - alt.total) : null,
    considered: d ? d.considered || null : null,
  };
}

/* ---------- a snapshot of every unit, after a side's turn ---------- */
function statusOf(u){
  if(u.removed) return 'destroyed';
  if(u.routing) return 'routed';
  if(u.turnOnly) return 'turned';
  if(u.shaken) return 'shaken';
  if(u.disrupted) return 'disrupted';
  return 'active';
}
function snapshotNow(turn){
  if(!rec) return;
  const units = (state.units || []).map(u => [u.id, u.removed ? null : { x: u.x, y: u.y }, u.formation || 'line', statusOf(u), u.brigadeId,
    lastConnected.has(u.id) ? lastConnected.get(u.id) : true]);
  const at = rec.snapshots.findIndex(s => s.turn === turn);
  const snap = { turn, units: clone(units) };
  if(at >= 0) rec.snapshots[at] = snap; else rec.snapshots.push(snap);
}
export const recSnapshot = guard(turn => snapshotNow(turn));

/* ---------- the app going into the background ---------- */
export const recVisibility = guard(hidden => {
  if(hidden && !hiddenSince) hiddenSince = now();
  else if(!hidden && hiddenSince){ hiddenMs += now() - hiddenSince; hiddenSince = 0; }
  if(rec) rec.hiddenMs = hiddenMs;
});

/* ---------- match end ---------- */
export const recFinalise = guard(outcome => {
  if(!rec || rec.endedAt) return rec;
  snapshotNow(state.turnNumber || 0);
  pushEvent('turn_end', state.turn || null, null, { wall_ts: now(), final: true });
  rec.endedAt = new Date().toISOString();
  rec.endReason = (outcome && outcome.endReason) || 'win_condition';
  rec.winner = (outcome && outcome.winner) || null;
  rec.isComplete = rec.endReason !== 'incomplete' && rec.endReason !== 'disconnect';
  rec.turns = state.turnNumber || null;
  rec.hiddenMs = hiddenMs;
  rec.derived.duration_s = Math.round((now() - t0) / 1000);
  rec.derived.active_s = Math.round(activeMs() / 1000);
  if(faults) rec.derived.recorder_faults = faults;
  return rec;
});
