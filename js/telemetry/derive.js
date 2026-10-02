/* =========================================================
   MATCH TELEMETRY: DERIVED MEASURES (build spec 1.1 / 2.5)

   Computed once, at match end, from the record's own events and snapshots,
   so they can be recomputed later from a stored record and checked against
   it. _b is Britain (red), _f France (blue); in group mode, team totals.
   Pure: no game state, no DOM.

   The counts the match export also prints (casualties, fights, artillery
   shots and hits, volleys, bonuses, dice) are counted from the same fields the
   export's summary section reads (the fight's diag rolls and bonus sources,
   the fire events, the Destroyed status), so the two agree by construction;
   tools/telemetry/derive-check.mjs compares them.
========================================================= */
const B = 'red', F = 'blue';
const SIDE_KEY = { red: 'b', blue: 'f' };
/* The break rule as checkWinCondition applies it (engine-rules.js): a Brigade
   is broken when every unit in it but its Brigadier is gone, and an army with
   BREAKS_TO_LOSE broken Brigades has lost. It cannot be called from here (it
   ends the game), so it is restated, with this pointer back to the source. */
const BREAKS_TO_LOSE = 2;

const r3 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function deriveMeasures(rec, extra = {}){
  const ev = rec.events || [];
  const of = t => ev.filter(e => e.type === t);
  const d = {};
  const unitMeta = new Map();          // id -> { side, type, brigade }
  for(const e of of('deploy')){ const u = e.payload.unit; if(u) unitMeta.set(u.id, { side: e.side, type: u.type, brigade: u.brigade }); }
  const isFighter = id => { const m = unitMeta.get(id); return m && m.type !== 'BRIGADIER'; };
  const sideOf = id => (unitMeta.get(id) || {}).side;

  // Units and casualties (Brigadiers excluded, as the export's summary does).
  const start = { red: 0, blue: 0 };
  for(const [, m] of unitMeta) if(m.type !== 'BRIGADIER' && start[m.side] != null) start[m.side]++;
  const destroyed = of('destroyed').filter(e => isFighter(e.unitId));
  const cas = { red: 0, blue: 0 };
  const byCause = { red: {}, blue: {} };
  for(const e of destroyed){ const s = e.side || sideOf(e.unitId); if(cas[s] == null) continue; cas[s]++; const c = e.payload.cause || 'combat'; byCause[s][c] = (byCause[s][c] || 0) + 1; }
  for(const s of [B, F]){ d[`units_start_${SIDE_KEY[s]}`] = start[s]; d[`casualties_${SIDE_KEY[s]}`] = cas[s]; d[`units_end_${SIDE_KEY[s]}`] = start[s] - cas[s]; }
  d.margin = rec.winner === B ? d.units_end_b - d.units_end_f : rec.winner === F ? d.units_end_f - d.units_end_b : null;

  // Fights: counts, dice, bonuses (from the fight's own diag, as the export).
  const fights = of('fight');
  const dice = { red: [], blue: [] }, bonus = { red: {}, blue: {} };
  for(const f of fights){
    const p = f.payload, dg = p.diag || {};
    if(dice[p.attackerSide]) dice[p.attackerSide].push(...(dg.aRolls || []));
    if(dice[p.defenderSide]) dice[p.defenderSide].push(...(dg.dRolls || []));
    for(const [s, list] of [[p.attackerSide, dg.aSources], [p.defenderSide, dg.dSources]]) for(const b of (list || [])) if(bonus[s]) bonus[s][b] = (bonus[s][b] || 0) + 1;
  }
  const bonusCount = s => Object.values(bonus[s]).reduce((a, b) => a + b, 0);
  d.bonus_b = bonusCount(B); d.bonus_f = bonusCount(F);
  d.bonus_ratio = d.bonus_b ? r3(d.bonus_f / d.bonus_b) : null;
  d.dice_mean_b = r3(mean(dice[B])); d.dice_mean_f = r3(mean(dice[F]));
  const dist = s => [1, 2, 3, 4, 5, 6].map(n => dice[s].filter(v => v === n).length);
  d.fights = fights.length;
  d.volleys = of('volley').length;
  const shots = of('artillery');
  d.art_shots = shots.length;
  d.art_hits = shots.filter(e => e.payload.hit === true).length;
  const byRange = {};
  for(const e of shots){ const r = e.payload.hitNeeded; if(r == null) continue; const b = byRange[r] = byRange[r] || { shots: 0, hits: 0 }; b.shots++; if(e.payload.hit) b.hits++; }

  // Contact.
  d.first_contact_turn = fights.length ? Math.min(...fights.map(f => f.turn)) : null;
  for(const s of [B, F]){
    const firstByBrigade = new Map();
    for(const f of fights){
      for(const id of [f.payload.attackerId, f.payload.defenderId]){
        const m = unitMeta.get(id);
        if(!m || m.side !== s) continue;
        if(!firstByBrigade.has(m.brigade) || firstByBrigade.get(m.brigade) > f.turn) firstByBrigade.set(m.brigade, f.turn);
      }
    }
    const brigades = new Set([...unitMeta.values()].filter(m => m.side === s).map(m => m.brigade));
    const turns = [...firstByBrigade.values()];
    d[`contact_spread_${SIDE_KEY[s]}`] = turns.length ? Math.max(...turns) - Math.min(...turns) : null;
    d[`brigades_uncontacted_${SIDE_KEY[s]}`] = [...brigades].filter(b => !firstByBrigade.has(b)).length;
  }

  // Units standing at each snapshot, and how close each side came to winning.
  const snaps = [...(rec.snapshots || [])].sort((a, b) => a.turn - b.turn);
  const alive = (snap, s) => snap.units.filter(t => t[1] && sideOf(t[0]) === s && isFighter(t[0]) && t[3] !== 'routed').length;
  if(rec.winner === B || rec.winner === F){
    const w = rec.winner, l = w === B ? F : B;
    let decided = null;
    for(const sn of snaps){ if(alive(sn, w) >= alive(sn, l)){ if(decided == null) decided = sn.turn; } else decided = null; }
    d.decided_turn = decided;
  } else d.decided_turn = null;
  const toWin = (snap, enemy) => {
    const left = {};
    for(const m of unitMeta.values()) if(m.side === enemy && m.type !== 'BRIGADIER') left[m.brigade] = left[m.brigade] || 0;
    for(const t of snap.units){ const m = unitMeta.get(t[0]); if(m && m.side === enemy && m.type !== 'BRIGADIER' && t[1]) left[m.brigade]++; }
    return Object.values(left).sort((a, b) => a - b).slice(0, BREAKS_TO_LOSE).reduce((a, b) => a + b, 0);
  };
  for(const s of [B, F]) d[`closest_${SIDE_KEY[s]}`] = snaps.length ? Math.min(...snaps.map(sn => toWin(sn, s === B ? F : B))) : null;

  // AI lines (from their printed text).
  const comboTexts = of('ai_combo').map(e => String(e.payload.text || ''));
  d.combos_planned = comboTexts.filter(t => /COMBO planned/.test(t)).length;
  d.combos_executed = comboTexts.filter(t => /COMBO (executed|fired|lead)/i.test(t)).length;
  d.combos_converted = comboTexts.filter(t => /COMBO converted/i.test(t)).length;
  const fin = of('ai_finishing').map(e => ({ turn: e.turn, text: String(e.payload.text || '') }));
  d.finishing_triggers = fin.filter(f => /FINISHING (triggered|armed|set|started)/i.test(f.text)).length;
  const resolvedTurns = fin.map(f => f.text.match(/resolved.*?after (\d+) turns?/i)).filter(Boolean).map(m => Number(m[1]));
  d.finishing_mean_turns = r3(mean(resolvedTurns));

  // Command chain.
  for(const s of [B, F]){
    d[`chain_breaks_${SIDE_KEY[s]}`] = of('chain_break').filter(e => e.side === s).length;
    d[`disconnected_turns_${SIDE_KEY[s]}`] = snaps.reduce((n, sn) => n + sn.units.filter(t => t[1] && sideOf(t[0]) === s && t[5] === false).length, 0);
  }

  // AI holds.
  const decisions = of('ai_decision');
  d.hold_rate = decisions.length ? r3(decisions.filter(e => e.payload.chosen === 'Hold').length / decisions.length) : null;

  // Follow-ups: of fights that turned the defender around (pushback), the share
  // where the same side attacked that defender again in the same turn and phase.
  for(const s of [B, F]){
    const turned = fights.filter(f => f.payload.attackerSide === s && f.payload.result === 'pushback');
    const again = turned.filter(f => fights.some(g => g.seq > f.seq && g.turn === f.turn && g.phase === f.phase &&
      g.payload.attackerSide === s && g.payload.defenderId === f.payload.defenderId));
    d[`follow_up_rate_${SIDE_KEY[s]}`] = turned.length ? r3(again.length / turned.length) : null;
  }

  // Flags and missed opportunities.
  const flags = extra.flags || [];
  const missed = of('missed_opportunity').map(e => ({ code: e.payload.code, turn: e.turn, unit: e.unitId, detail: e.payload.detail || null }));
  d.flag_count = flags.length;
  d.missed_opp_count = missed.length;

  // The breakdowns.
  const missionDist = {};
  for(const e of decisions){ const m = typeof e.payload.mission === 'string' ? e.payload.mission : (e.payload.mission && e.payload.mission.type) || 'none'; missionDist[m] = (missionDist[m] || 0) + 1; }
  Object.assign(d, {
    casualties_by_cause: { b: byCause[B], f: byCause[F] },
    bonus_by_type: { b: bonus[B], f: bonus[F] },
    dice_dist: { b: dist(B), f: dist(F) },
    art_hit_rate_by_range: Object.fromEntries(Object.entries(byRange).map(([r, b]) => [r, { shots: b.shots, hits: b.hits, rate: r3(b.hits / b.shots) }])),
    mission_dist: missionDist,
    flags,
    missed_opps: missed,
  });
  return d;
}

/* The export's own diagnostic flags (section 6), one per line. */
export function flagsFromExport(text){
  const lines = String(text || '').split('\n');
  const at = lines.findIndex(l => l.startsWith('=== SECTION 6'));
  if(at < 0) return [];
  const out = [];
  for(const l of lines.slice(at + 1)){
    if(l.startsWith('===')) break;
    const t = l.trim();
    if(!t || /^No anomalies detected/.test(t)) continue;
    const turn = t.match(/\bT(\d+)\b/);
    out.push({ code: (t.match(/^([A-Z][A-Z_]{3,})\b/) || [])[1] || null, turn: turn ? Number(turn[1]) : null, unit: null, text: t });
  }
  return out;
}

/* The AI's term table, from summariseAiDecisions (the same numbers section 4
   of the export prints). */
export function termRows(summary){
  if(!summary || !summary.spreads) return [];
  return Object.keys(summary.spreads).sort().map(k => {
    const sp = summary.spreads[k] || [];
    const rg = summary.ranges[k] || { lo: null, hi: null };
    return { term: k, min: r3(rg.lo), max: r3(rg.hi), spread: r3(mean(sp)), range: rg.lo == null ? null : r3(rg.hi - rg.lo),
      mean: null, n: sp.length, decidedCount: summary.decided[k] || 0 };
  });
}
