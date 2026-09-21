/* =========================================================
   THE SIMULATOR

   Plays full matches with the same AI on both sides, headless, and aggregates
   the results.

   HOW BOTH SIDES ARE DRIVEN. It does not drive them. Spectate mode already does,
   in js/, and this runs that: state.spectate points state.aiSide at whichever
   side is acting, so the same scoring, the same weights and the same doctrine
   play both. The runner sets the flag, starts the match and reads the result.

   THAT IS THE WHOLE DESIGN CHANGE FROM THE PREVIOUS VERSION. The old runner
   carried its own turn driver and two kicks (re-arm the deploy chain, press
   Start Battle) because there was no in-game path for an unattended match.
   Spectate is that path, so all of it is gone. What runs here is what runs on
   the phone, which is the only way a batch result says anything about the game
   that is actually played.

   Usage:  node tools/sim/run.mjs [matches] [--seed N] [--json out.json]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import fs from 'fs';
import { resolveVariant } from './variants.mjs';
import { materialiseVersion, cleanVersions, describeRef, labelFor } from './versions.mjs';

/* Captured BEFORE collapseTimers replaces the global. The runner still needs a
   real clock to poll and to time out with; only the game's own pacing goes. */
const realSetInterval = globalThis.setInterval;
const POLL_MS = 4;

/* A STALLED MATCH IS CAPPED ON TURNS, NOT ON THE CLOCK.

   A wall-clock timeout was costing sixty seconds per stall, which at a 15% rate
   was most of the running time of every batch: forty matches took fifteen
   minutes, of which nine were spent watching armies not move.

   400 side activations is 200 full rounds. The longest match that has ever
   DECIDED is 252 activations, so the cap cannot cut a real game short, and a
   stall reaches it in about two seconds instead of sixty. Same information,
   twenty times faster, and it is deterministic rather than dependent on how busy
   the machine was.

   The wall-clock limit stays as a backstop for a match that hangs rather than
   stalls (a frozen callback chain stops advancing turnNumber at all, so the turn
   cap would never fire). It should never be the thing that trips. */
const MATCH_TURN_CAP = 400;
const MATCH_TIMEOUT_MS = 45_000;

export async function runOneMatch({ seed, variant = 'control', variantSide = null, oldEntry = null }, g) {
  const { data, dice, rules, render, menus } = g;
  const { state, SIDES } = data;

  dice.setFastDiceMode(true);
  render.setFastAnimationMode(true);

  /* Exactly what the Spectate button sets, and nothing else. If this list ever
     drifts from ui-menus, the runner stops testing the shipped mode. */
  state.scenario = null;
  state.campaign = null;
  state.mode = 'ai';
  state.spectate = true;
  state.aiDifficulty = 'hard';
  state.aiSide = SIDES.RED;
  state.gameOver = false;
  state.winner = null;
  state.turnNumber = 1;

  /* Deterministic per match so any single result can be reproduced. NOTE: board
     assignment and rotation in beginBoardSetup use Math.random directly rather
     than the seeded generator, so THE SEED FIXES THE DICE, NOT THE MAP. The
     board drawn is recorded per match below so a result stays identifiable. */
  rules.seedRng(seed);

  /* THE VARIANT IS AN OVERRIDE TABLE ON ONE SIDE, NOT A SECOND AI.

     ai-strategy reads every wired weight through tune(side, ...), which falls
     back to the module constant when a side has no entry. So the control side
     literally runs the shipped code path with no overrides, rather than a copy
     of it that could drift. Both armies share the same scoring, the same
     doctrine and the same everything else, which is the only way the win rate
     isolates the change. */
  state.aiConfig = { red: {}, blue: {} };
  /* SIM_REVERSE flips which side of an experiment is the control, so a result
     can be checked by running it backwards. */
  if (process.env.SIM_REVERSE) { g.rules.setStrandedRejoinDefault(true); }
  if (variantSide) state.aiConfig[variantSide] = resolveVariant(variant);

  /* VERSION vs VERSION. The variant side keeps the CURRENT AI and the other side
     is handed the old one, so 'variant wins' means the new build beat the old
     build. Registered per match rather than once per process because the swap
     puts the old AI on the opposite side on the next match. */
  if (oldEntry && variantSide) {
    const older = await import(oldEntry);
    const other = variantSide === 'red' ? 'blue' : 'red';
    g.router.clearAiVersions();
    g.router.registerAiVersion(other, older);
  }

  const t0 = Date.now();
  const reach = installReachTracker(state, g, SIDES);
  menus.beginBoardSetup();

  /* SIM_MIRROR=1 FLIPS THE BOARD TOP TO BOTTOM AND LEAVES THE ARMIES WHERE THEY
     ARE. France still deploys on rows 0-1 and Britain on rows 8-9; only the
     terrain moves, so whatever ground France was sitting on is now Britain's.

     This exists to answer one question. Across 96 matches France won 61% of
     decided games no matter which build was playing it, which means the per-side
     halves of every head-to-head verdict this project has produced are partly
     reading the board rather than the change under test. If the advantage
     follows the terrain when the terrain moves, it is the board. If France keeps
     winning on mirrored ground, it is something else and the deployment rows or
     the turn order are the next place to look.

     state.terrain is indexed [y][x], so reversing the outer array is the flip.
     Applied after setup, which means deployment chose its squares on the
     unmirrored board. That is a known impurity and an acceptable one: deployment
     is confined to each side's own two rows either way, and the terrain a unit
     FIGHTS over is what the run is measuring. */
  if (process.env.SIM_MIRROR === '1' && Array.isArray(state.terrain)) {
    state.terrain.reverse();
  }

  const finished = await waitForEnd(state, MATCH_TIMEOUT_MS);
  const living = side => state.units.filter(u => !u.removed && u.side === side).length;

  const variantWon = variantSide && state.winner
    ? (state.winner === variantSide ? 'variant' : 'control') : null;

  return {
    seed,
    variant, variantSide, variantWon, vsRef: (oldEntry ? (process.env.SIM_VS_LABEL || 'older build') : null),
    finished,                       // 'win' | 'stalled' | 'hung'
    winner: state.winner || null,
    turns: state.turnNumber,
    wallMs: Date.now() - t0,
    board: JSON.stringify(state.boardAssignment) + ' rot ' + JSON.stringify(state.boardRotation),
    survivors: { red: living(SIDES.RED), blue: living(SIDES.BLUE) },
    brokenBrigades: countBrokenBrigades(state, SIDES),
    stall: finished === 'win' ? null : snapshotStall(state, SIDES),
    remnants: remnantsOf(state, SIDES),
    reach: reach.result(),
  };
}

/* A broken brigade is the win condition, so it is the one tally worth taking
   from every match rather than reconstructing it later from the log. */
function countBrokenBrigades(state, SIDES) {
  const out = { red: 0, blue: 0 };
  for (const side of [SIDES.RED, SIDES.BLUE]) {
    const key = side === SIDES.RED ? 'red' : 'blue';
    /* brigadeId, NOT brigade. The first version of this read u.brigade, which
       does not exist on a unit, so every unit grouped under one undefined key
       and the tally was silently meaningless rather than wrong-looking. */
    const brigades = new Set(state.units.filter(u => u.side === side).map(u => u.brigadeId));
    for (const b of brigades) {
      const alive = state.units.filter(u => u.side === side && u.brigadeId === b &&
                                            !u.removed && u.type !== 'BRIGADIER').length;
      if (alive === 0) out[key]++;
    }
  }
  return out;
}


function readLogTail(n) {
  try {
    const el = document.getElementById('log');
    if (!el) return [];
    return [...el.children].slice(-n).map(d => d.textContent);
  } catch { return []; }
}

/* WHAT A STALLED MATCH LOOKED LIKE AT THE MOMENT IT WAS ABANDONED.

   A match that will not end is the most valuable thing a long run finds and the
   hardest to get back, because the seed does not fix the map (see above), so
   re-running the same seed plays a different battle. Confirmed the hard way:
   seed 5 timed out at turn 2380 in one batch and finished at turn 82 on the next
   run. The snapshot therefore has to be taken while it is happening. */
function snapshotStall(state, SIDES) {
  const live = side => state.units.filter(u => !u.removed && u.side === side);
  const r = live(SIDES.RED), b = live(SIDES.BLUE);
  let minGap = 99, contacts = 0;
  for (const a of r) for (const c of b) {
    const d = Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y));
    if (d < minGap) minGap = d;
    if (d <= 1) contacts++;
  }
  const place = us => us.map(u => `${u.type}@${u.x},${u.y}${u.formation === 'line' ? '' : '/' + u.formation}`);
  return {
    minGap, contacts,
    red: place(r), blue: place(b),
    /* log() writes straight into the #log element rather than onto state, so
       the tail is read back out of the DOM. Headless that DOM is jsdom's, which
       is why this works at all. */
    tail: readLogTail(25),
    events: (state.matchLog || []).slice(-15),
  };
}

/* Resolves when the match reports itself over, or when the wall clock runs out.
   A TIMEOUT IS A RESULT, NOT AN ERROR. A match that will not end is exactly the
   thing a long run exists to find, so it is recorded against its seed rather
   than crashing the batch. */
/* WHEN A UNIT COULD HAVE GONE FOR A REMNANT, DID IT?

   The remnant survival time mixes two different things: remnants nobody could
   reach, and remnants somebody could reach and did not. Only the second is a
   decision. This isolates it.

   A snapshot at every turn boundary brackets exactly one side's moves. For the
   side that just moved, every enemy Brigade that was at its last fighting unit
   at the start of that turn, and every one of the mover's units that COULD move
   and was in reach of it:
     cavalry and infantry within 4 tiles   closed / held / opened
     guns with line of sight at range 5+   closed to 4 or less / stayed out
   Positions only, from shared engine code, so it is the same measurement
   whichever build is playing either side. */
function installReachTracker(state, g, SIDES) {
  const { movableUnitsForSide, chebyshev, hasLOS, legalMoves } = g.rules;
  const T = g.data.UNIT_TYPES;
  const tally = {};
  for (const s of [SIDES.RED, SIDES.BLUE]) tally[s] = { near: 0, closed: 0, held: 0, opened: 0, gunsFar: 0, gunsClosed: 0, heldNoWay: 0, heldCould: 0, recruited: 0, recruitedClosed: 0 };
  let prev = null;
  globalThis.__fcTurnHook = st => {
    const mover = st.turn === SIDES.RED ? SIDES.BLUE : SIDES.RED;   // the side that just finished
    if (prev && prev.side === mover) {
      const byId = new Map(st.units.map(u => [u.id, u]));
      for (const r of prev.remnants) {
        const R = byId.get(r.id);
        if (!R || R.removed) continue;
        for (const m of prev.units) {
          if (!prev.movable.has(m.id)) continue;
          const U = byId.get(m.id);
          if (!U || U.removed) continue;
          const d0 = Math.max(Math.abs(m.x - r.x), Math.abs(m.y - r.y));
          const d1 = chebyshev(U, R);
          const tl = tally[mover];
          if (T[m.type].isArtillery) {
            if (d0 > 4 && m.los[r.id]) { tl.gunsFar++; if (d1 <= 4) tl.gunsClosed++; }
          } else if (d0 <= 4) {
            tl.near++;
            /* Diagnostic, current build only: did the finishing rule actually
               give this unit a role against THIS remnant on that turn? Read from
               the per-turn cache finishRoleFor leaves on the unit; absent in
               older builds, where it simply never counts. */
            const role = U._finRoleTurn === prev.turn && U._finRole && U._finRole.f && U._finRole.f.targetId === r.id;
            if (role) { tl.recruited++; if (d1 < d0 || d1 <= 1) tl.recruitedClosed++; }
            /* WHAT BEAT THE PULL. For a recruited unit that did not close, find
               the runner-up in its own decision log that WAS closer, and credit
               each term by how much it favoured the square chosen instead. */
            if (role && !(d1 < d0 || d1 <= 1)) {
              const hist = (st._aiMoveHistory && st._aiMoveHistory[mover]) || [];
              const h = [...hist].reverse().find(e => e.turn === prev.turn && e.type === U.type &&
                e.brigadeId === U.brigadeId && e.decision && e.decision.chosen &&
                e.decision.chosen.x === U.x && e.decision.chosen.y === U.y);
              const alt = h && (h.decision.alternatives || []).find(a =>
                Math.max(Math.abs(a.x - R.x), Math.abs(a.y - R.y)) < d0);
              if (alt) {
                tl.beaten = (tl.beaten || 0) + 1;
                tl.by = tl.by || {};
                const keys = new Set([...Object.keys(h.decision.chosen.parts), ...Object.keys(alt.parts)]);
                for (const k of keys) {
                  const diff = (h.decision.chosen.parts[k] || 0) - (alt.parts[k] || 0);
                  if (diff > 0) tl.by[k] = (tl.by[k] || 0) + diff;
                }
              } else if (h) tl.noCloserAlt = (tl.noCloserAlt || 0) + 1;
            }
            if (d1 < d0 || d1 <= 1) tl.closed++;
            else {
              if (d1 === d0) tl.held++; else tl.opened++;
              /* Could it have closed? A closer legal square at the start of the
                 turn separates "no way to get there" from "chose not to". */
              if ((m.closer || {})[r.id]) tl.heldCould++; else tl.heldNoWay++;
            }
          }
        }
      }
    }
    const next = st.turn;                                              // about to move
    const enemy = next === SIDES.RED ? SIDES.BLUE : SIDES.RED;
    const remnants = [];
    for (let b = 0; b < 3; b++) {
      const alive = st.units.filter(u => !u.removed && u.side === enemy && u.brigadeId === b && u.type !== 'BRIGADIER');
      if (alive.length === 1) remnants.push({ id: alive[0].id, x: alive[0].x, y: alive[0].y });
    }
    const movable = new Set([...movableUnitsForSide(next)].filter(id => {
      const u = st.units.find(x => x.id === id); return u && !u.turnOnly;
    }));
    const units = st.units.filter(u => !u.removed && u.side === next && u.type !== 'BRIGADIER').map(u => {
      const los = {}, closer = {};
      for (const r of remnants) {
        const R = st.units.find(x => x.id === r.id);
        if (T[u.type].isArtillery) { los[r.id] = hasLOS(u, R); continue; }
        const d0 = chebyshev(u, R);
        if (d0 > 4 || !movable.has(u.id)) continue;
        let moves = [];
        try { moves = legalMoves(u) || []; } catch { moves = []; }
        closer[r.id] = moves.some(c => Math.max(Math.abs(c.x - R.x), Math.abs(c.y - R.y)) < d0);
      }
      return { id: u.id, type: u.type, x: u.x, y: u.y, los, closer };
    });
    prev = remnants.length ? { side: next, turn: st.turnNumber, remnants, units, movable } : null;
  };
  return { result: () => tally };
}

/* EVERY BRIGADE THAT SPENT TIME AT ITS LAST FIGHTING UNIT, and for how long.
   From the removal turn stamped on each unit, not from polling, so it is exact
   and it is the same measurement whichever build is playing either side. A
   remnant starts when its second-last unit dies and ends when its last one does;
   to is null if the match ended with it still standing. */
function remnantsOf(state, SIDES) {
  const out = [];
  for (const side of [SIDES.RED, SIDES.BLUE]) {
    for (let bId = 0; bId < 3; bId++) {
      const members = state.units.filter(u => u.side === side && u.brigadeId === bId && u.type !== 'BRIGADIER');
      if (members.length < 2) continue;
      const deaths = members.filter(u => u.removed).map(u => u.removedTurn ?? 0).sort((a, b) => a - b);
      if (deaths.length < members.length - 1) continue;          // never got down to one
      const from = deaths[members.length - 2];
      const to = deaths.length === members.length ? deaths[members.length - 1] : null;
      out.push({ side, brigadeId: bId, from, to, endTurn: state.turnNumber });
    }
  }
  return out;
}

function waitForEnd(state, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const poll = realSetInterval(() => {
      if (state.gameOver) { clearInterval(poll); resolve('win'); return; }
      /* 'stalled' and 'hung' are different results and are reported separately.
         A stall is two armies that will not commit and is a finding about the
         AI; a hang is the game not advancing at all and is a bug. Collapsing
         them into one 'timeout' hid that distinction for three batches. */
      if (state.turnNumber > MATCH_TURN_CAP) { clearInterval(poll); resolve('stalled'); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(poll); resolve('hung'); return; }
    }, POLL_MS);
  });
}

/* ---------------------------------------------------------
   AGGREGATION
--------------------------------------------------------- */
/* THE VARIANT VERDICT.

   UNDECIDED MATCHES ARE EXCLUDED, not scored as draws. A stall is a failure of
   both AIs to commit and says nothing about which weights are better; folding it
   in as half a win would let a change that made matches MORE likely to stall
   look neutral. The count is reported on its own line instead, where a variant
   that raises the stall rate is visible as the regression it is. That has
   already happened twice.

   The 60/55 thresholds are the brief's and they are not arbitrary: on ~170
   decided matches the standard error on a win rate is about 4 points, so 55% is
   inside noise and 60% is not. */
function verdict(results) {
  const played = results.filter(r => r.variantSide);
  if (!played.length) return null;
  const decided = played.filter(r => r.finished === 'win' && r.variantWon);
  /* Two runs wear the same shape and must not read the same. In a weight run the
     opponent is the current build with no overrides; in a version run it is a
     different build entirely, and calling that "control" would suggest the new
     code losing to itself. */
  const ref = played[0].vsRef;
  const NEW = ref ? 'current build' : `variant '${played[0].variant}'`;
  const OLD = ref ? ref : 'control';
  const lines = ['', `=== ${NEW.toUpperCase()} vs ${OLD.toUpperCase()} ===`];
  const tally = set => {
    const w = set.filter(r => r.variantWon === 'variant').length;
    return { w, n: set.length, pct: set.length ? Math.floor((w / set.length) * 1000) / 10 : 0 };
  };
  const all = tally(decided);
  const asRed  = tally(decided.filter(r => r.variantSide === 'red'));
  const asBlue = tally(decided.filter(r => r.variantSide === 'blue'));

  lines.push(`decided            ${decided.length} of ${played.length}` +
             `   (${played.length - decided.length} excluded: stalled, hung or crashed)`);
  lines.push(`${NEW} win rate`.padEnd(18) + ` ${all.w}/${all.n}  ${all.pct}%`);
  lines.push(`  as Britain       ${asRed.w}/${asRed.n}  ${asRed.pct}%`);
  lines.push(`  as France        ${asBlue.w}/${asBlue.n}  ${asBlue.pct}%`);
  const bothSides = asRed.pct > 50 && asBlue.pct > 50;
  lines.push('');
  lines.push(all.pct >= 60 && bothSides ? 'IMPROVEMENT: above 60% and present on both sides of the swap.'
    : all.pct >= 60 ? 'INCONCLUSIVE: above 60% overall but NOT on both sides. That is a side effect, not a change effect.'
    : all.pct > 55 ? 'WORTH A SECOND RUN: between 55% and 60%.'
    : all.pct < 45 ? `REGRESSION: ${OLD} is winning.`
    : 'NOISE: within 55%, no effect detected.');

  /* FINISHING. How long an enemy Brigade survives at its last fighting unit,
     split by WHO WAS HUNTING it. Measured from death turns on the units, so it
     is the same measurement for both builds. */
  const hunts = { [NEW]: [], [OLD]: [] };
  for (const r of played) {
    if (!r.variantSide || !r.remnants) continue;
    for (const m of r.remnants) hunts[m.side === r.variantSide ? OLD : NEW].push(m);
  }
  const fmt = x => (Math.floor(x * 10) / 10).toFixed(1);
  const median = xs => { const a = [...xs].sort((p, q) => p - q); return a.length % 2 ? a[(a.length - 1) / 2] : Math.floor((a[a.length / 2 - 1] + a[a.length / 2]) / 2); };
  lines.push('');
  lines.push('REMNANTS (enemy Brigade down to its last fighting unit), by the side hunting it');
  for (const who of [NEW, OLD]) {
    const set = hunts[who];
    const done = set.filter(m => m.to != null);
    const open = set.length - done.length;
    const mean = done.length ? done.reduce((a, m) => a + (m.to - m.from), 0) / done.length : 0;
    const slow = done.filter(m => m.to - m.from >= 6).length;
    lines.push(`  hunted by ${who}`.padEnd(30) + ` ${set.length} remnants, ${done.length} finished` +
      (done.length ? ` in mean ${fmt(mean)} / median ${median(done.map(m => m.to - m.from))} turns (${slow} took 6+)` : '') +
      `, ${open} still standing at match end`);
  }
  /* Within reach: the part of finishing that is actually a decision. */
  const blank = () => ({ near: 0, closed: 0, held: 0, opened: 0, gunsFar: 0, gunsClosed: 0, heldNoWay: 0, heldCould: 0, recruited: 0, recruitedClosed: 0 });
  const reachBy = { [NEW]: blank(), [OLD]: blank() };
  for (const r of played) {
    if (!r.variantSide || !r.reach) continue;
    for (const side of Object.keys(r.reach)) {
      const who = side === r.variantSide ? NEW : OLD;
      for (const k of Object.keys(blank())) reachBy[who][k] += r.reach[side][k] || 0;
      const src = r.reach[side], dst = reachBy[who];
      dst.beaten = (dst.beaten || 0) + (src.beaten || 0);
      dst.noCloserAlt = (dst.noCloserAlt || 0) + (src.noCloserAlt || 0);
      for (const [k, v] of Object.entries(src.by || {})) { dst.by = dst.by || {}; dst.by[k] = (dst.by[k] || 0) + v; }
    }
  }
  const pc = (a, b) => b ? `${Math.floor(a * 1000 / b) / 10}%` : '-';
  lines.push('');
  lines.push('WITHIN REACH OF A REMNANT (unit able to move, cav/inf within 4, guns with LOS at 5+)');
  for (const who of [NEW, OLD]) {
    const x = reachBy[who];
    lines.push(`  ${who}`.padEnd(30) + ` units in reach ${x.near}: closed ${pc(x.closed, x.near)}, held ${pc(x.held, x.near)}, opened ${pc(x.opened, x.near)}` +
      `  |  guns out at 5+ ${x.gunsFar}: closed to 4 ${pc(x.gunsClosed, x.gunsFar)}`);
    const notClosed = x.heldNoWay + x.heldCould;
    lines.push(`    of the ${notClosed} that did not close: ${x.heldCould} had a closer legal square (chose not to), ${x.heldNoWay} had none`);
    if (x.beaten || x.noCloserAlt) {
      const top = Object.entries(x.by || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `${k} ${(Math.floor(v * 100 / Math.max(1, x.beaten)) / 100).toFixed(2)}`).join(', ');
      lines.push(`    recruited, held, closer square in its top 4: ${x.beaten || 0}; closer square not even in its top 4: ${x.noCloserAlt || 0}`);
      if (x.beaten) lines.push(`    terms favouring the square it chose, mean per case: ${top}`);
    }
    if (x.recruited) lines.push(`    recruited by the finishing rule: ${x.recruited}, of which closed ${pc(x.recruitedClosed, x.recruited)}; ` +
      `not recruited: ${x.near - x.recruited}, closed ${pc(x.closed - x.recruitedClosed, x.near - x.recruited)}`);
  }
  return lines.join('\n');
}

export function summarise(results) {
  const done = results.filter(r => r.finished === 'win');
  const wins = { red: 0, blue: 0, none: 0 };
  for (const r of done) {
    if (r.winner === 'red') wins.red++;
    else if (r.winner === 'blue') wins.blue++;
    else wins.none++;
  }
  const turns = done.map(r => r.turns).sort((a, b) => a - b);
  const pct = n => (results.length ? Math.floor((n / results.length) * 1000) / 10 : 0);
  const median = turns.length ? turns[Math.floor(turns.length / 2)] : null;

  const lines = [];
  lines.push(`matches            ${results.length}`);
  lines.push(`completed          ${done.length} (${pct(done.length)}%)`);
  lines.push(`stalled            ${results.filter(r => r.finished === 'stalled').length} (${pct(results.filter(r => r.finished === 'stalled').length)}%)`);
  lines.push(`hung               ${results.filter(r => r.finished === 'hung').length}`);
  lines.push(`crashed            ${results.filter(r => r.finished === 'crashed').length}`);
  lines.push('');
  lines.push(`Britain (red) wins ${wins.red} (${pct(wins.red)}%)`);
  lines.push(`France (blue) wins ${wins.blue} (${pct(wins.blue)}%)`);
  if (wins.none) lines.push(`no winner recorded ${wins.none}`);
  if (turns.length) {
    lines.push('');
    lines.push(`turns   shortest ${turns[0]}  median ${median}  longest ${turns[turns.length - 1]}`);
    const surv = done.reduce((a, r) => ({ red: a.red + r.survivors.red, blue: a.blue + r.survivors.blue }),
                             { red: 0, blue: 0 });
    lines.push(`mean survivors   Britain ${Math.floor(surv.red / done.length * 10) / 10}` +
               `  France ${Math.floor(surv.blue / done.length * 10) / 10}`);
  }
  const stuck = results.filter(r => r.finished !== 'win');
  if (stuck.length) {
    lines.push('');
    lines.push('SEEDS THAT DID NOT FINISH CLEANLY (reproduce with: node tools/sim/run.mjs 1 --seed N)');
    for (const r of stuck) {
      lines.push(`  seed ${r.seed} ${r.finished} at turn ${r.turns}` +
                 (r.stall ? `  survivors ${r.survivors.red}v${r.survivors.blue}` +
                            `  closest units ${r.stall.minGap} apart, ${r.stall.contacts} in contact` : ''));
    }
    lines.push('  (seeds reproduce exactly — stall-probe.mjs takes the same seed)');
  }
  const v = verdict(results);
  if (v) lines.push(v);
  return lines.join('\n');
}

/* ---------------------------------------------------------
   ONE MATCH PER PROCESS

   The game keeps its state in a module singleton, and a finished match leaves
   things behind: a deferred endGame timer waiting out the brigade-break
   dispatch, the previous roster, the undo stack. Running a second match in the
   same process produced instant turn-1 "wins" from that residue, which is a
   harness artefact and would have quietly poisoned a hundred-match tally.

   Rather than hunt every field that needs clearing (and re-hunt it whenever a
   new one is added), each match gets a clean process. It costs about a second
   of module loading per match and buys total isolation, plus a crashed match
   now loses one result instead of the batch.
--------------------------------------------------------- */
async function runChild(seed, variant, variantSide) {
  const g = await loadGame();
  g.render = await import('../../js/render-board.js');
  g.menus  = await import('../../js/ui-menus.js');
  g.router = await import('../../js/ai-router.js');
  collapseTimers();
  const r = await runOneMatch({ seed, variant, variantSide, oldEntry: process.env.SIM_OLD_ENTRY || null }, g);
  process.stdout.write('\u0001RESULT' + JSON.stringify(r) + '\n');
  process.exit(0);
}

export async function main() {
  const args = process.argv.slice(2);
  const childAt = args.indexOf('--child');
  if (childAt > -1) return runChild(Number(args[childAt + 1]), args[childAt + 2], args[childAt + 3] || null);

  const { spawn } = await import('node:child_process');
  const n = Number(args.find(a => /^\d+$/.test(a)) || 5);
  const jsonAt = args.indexOf('--json');
  const seedAt = args.indexOf('--seed');
  const firstSeed = seedAt > -1 ? Number(args[seedAt + 1]) : 1;

  /* RUN THEM IN PARALLEL. Each match is already its own process for isolation,
     so concurrency is free: they share nothing. Sequentially a forty-match batch
     was most of ten minutes, which is long enough that it stops being something
     you run after a change and starts being something you put off.

     Defaults to the machine's core count capped at 8. Results are collected by
     seed and sorted afterwards, so the printed order is stable and a batch is
     reproducible however the scheduler interleaves it. */
  const jobsAt = args.indexOf('--jobs');
  const jobs = Math.max(1, jobsAt > -1 ? Number(args[jobsAt + 1])
                                       : Math.min(8, (await import('node:os')).cpus().length || 4));

  const runOne = ({ seed, variant, variantSide }) => new Promise(resolve => {
    let out = '';
    const child = spawn(process.execPath,
      [process.argv[1], '--child', String(seed), variant, variantSide || ''],
      { cwd: process.cwd() });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => {});   // game logging, not wanted in a batch
    child.on('close', code => {
      const line = out.split('\n').find(l => l.startsWith('\u0001RESULT'));
      if (line) { resolve(JSON.parse(line.slice(7))); return; }
      /* A CRASH IS A RESULT TOO, and the most interesting kind: it names a seed
         that breaks the game rather than merely stalling it. */
      resolve({ seed, variant, variantSide, variantWon: null, finished: 'crashed',
                winner: null, turns: 0, wallMs: 0, exitCode: code,
                survivors: { red: 0, blue: 0 } });
    });
  });

  let variant = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : null;

  /* --vs <ref> plays the CURRENT build against the AI as it was at that commit.
     The old files are materialised once here and the children just import them,
     so git is touched a single time per run rather than once per match. */
  const vsAt = args.indexOf('--vs');
  let vs = null;
  if (vsAt > -1) {
    cleanVersions();
    vs = materialiseVersion(args[vsAt + 1]);
    process.env.SIM_OLD_ENTRY = vs.entry;
    /* The tag name when there is one, otherwise the short hash. The full subject
       line is useful in the header above and absurd inside a table column and a
       verdict sentence, but 'cerberus' is both short and meaningful where a hash
       is only short. */
    process.env.SIM_VS_LABEL = labelFor(args[vsAt + 1]);
    if (!variant) variant = 'control';   // current build, no overrides, versus the old one
    console.log(`current build  vs  ${describeRef(args[vsAt + 1])}`);
  }
  /* SWAP THE SIDES, ALWAYS, when running a variant. Every seed is played twice,
     once with the variant on Britain and once on France. Anything that makes a
     side more willing to close advantages whoever is not first into contact, so
     a one-sided run measures the side as much as the change. Reported split by
     side as well as pooled, so a result that only appears on one side is visible
     as the artefact it is rather than averaged into a verdict. */
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const seed = firstSeed + i;
    if (!variant) { seeds.push({ seed, variant: 'control', variantSide: null }); continue; }
    seeds.push({ seed, variant, variantSide: 'red' });
    seeds.push({ seed, variant, variantSide: 'blue' });
  }
  const results = [];
  let next = 0, done = 0;
  console.log(`${seeds.length} matches, ${jobs} at a time` +
              (variant ? `  |  variant '${variant}' vs control, sides swapped` : '') + '\n');
  await Promise.all(Array.from({ length: Math.min(jobs, n) }, async () => {
    while (next < seeds.length) {
      const r = await runOne(seeds[next++]);
      results.push(r);
      done++;
      console.log(`  [${String(done).padStart(3)}/${seeds.length}] seed ${r.seed}  ${r.finished.padEnd(7)}` +
                  ` ${r.variantSide ? ('v=' + r.variantSide + ' ') : ''}winner=${String(r.winner).padEnd(5)} turns=${String(r.turns).padStart(3)}` +
                  `  survivors ${r.survivors.red}v${r.survivors.blue}  ${(r.wallMs / 1000).toFixed(1)}s`);
    }
  }));
  results.sort((a, b) => a.seed - b.seed || String(a.variantSide).localeCompare(String(b.variantSide)));
  console.log('\n' + summarise(results));
  if (vs) cleanVersions();
  if (jsonAt > -1) {
    fs.writeFileSync(args[jsonAt + 1], JSON.stringify(results, null, 2));
    console.log(`\nwritten to ${args[jsonAt + 1]}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
