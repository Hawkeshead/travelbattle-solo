/* =========================================================
   REAL-TIME FIELD COMMAND: the AI (Phase 5).

   Plays under exactly the same limits as the player: the same order pool,
   cooldowns, range cap and chain, and every order goes through the same
   issueOrder() gate, so it cannot do anything a player could not.

   Not superhumanly fast: it looks at the board every AI_EVAL_TICKS (2s), and
   what it decides is carried out 1 to 2s later (AI_REACTION_TICKS), after the
   gate has checked it again against the battle as it then stands.

   What it decides, brigade by brigade:
   - BANK OR SPEND. A Brigade holds its orders until it has enough to move
     most of its ready units together (a wave), then spends them in one go;
     orders are spent early only to answer a threat (cavalry closing on
     infantry: form Square).
   - WHERE TO MAKE CONTACT. Melee is automatic, so choosing a square is
     choosing a fight: each unit heads for the enemy its Brigade is aiming at,
     keeping beside its Brigade mates or its Brigadier so the chain holds, and
     prefers high ground and cover on the way. Guns stay put while they have a
     target.
   - THE BRIGADIER leads from behind the front: free to move, he keeps to the
     square beside the most of his own units, so the chain follows the wave and
     he can reach anyone cut off.
   - ARTILLERY locks onto the best target in its line of fire (Columns and
     stacks first, then units in the open, then the nearest) and re-chooses when
     the lock breaks.

   A departure from the plan, logged in RTS_DEPARTURES.md: the plan asked for
   the turn-based move scorer to be forked and reused per unit. That scorer is
   built round the turn phases (move, fire, fight, declared attacks) and has
   nothing that maps onto auto-melee or banking, so this first RTS AI is its
   own, simpler rule set. The turn-based AI is untouched.
========================================================= */
import { AI_EVAL_TICKS, AI_REACTION_TICKS } from './constants.js';
import { brigadeKey, isBusy, issueOrder, poolOf, readiness01, stackPartner } from './sim.js';
import { nextRandom } from './rng.js';

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isFoot = u => u.type === 'INFANTRY' || u.type === 'GUARD';
const isCav = u => u.type === 'LIGHT_CAV' || u.type === 'HEAVY_CAV';
const TERRAIN_PREF = { HILL: -0.35, WOODS: -0.25, BUILDING: -0.3 };

/* Behaviour settings, so variants can be measured head to head in the
   simulator (tools/sim/rts-run.mjs with RTS_AI_VARIANT). DEFAULTS is the
   shipped AI. */
export const AI_DEFAULTS = {
  waveShare: 0.6,          // bank until the pool covers this share of the ready units
  gangUp: 1.5,             // bonus for a square beside an enemy already in a fight (a second attacker); won 61% of 80 decided vs. 0
  weakTarget: 0,           // pull toward enemies that are turned around, off their chain or alone
  gunsAdvance: true,       // a gun with nothing in its line of fire moves up (won 68% of 79 decided vs. staying put)
};
export function createAi(side, { phase = 0, tune = {} } = {}){
  return { side, tune: { ...AI_DEFAULTS, ...tune }, queue: [], nextEval: phase, stats: { ordersIssued: 0, refused: 0, waves: 0 } };
}

/* Called once per tick, after step(). */
export function aiTick(ai, b, rules){
  if(b.over) return;
  // Carry out what was decided a moment ago; the gate re-checks everything.
  while(ai.queue.length && ai.queue[0].at <= b.tick){
    const { order } = ai.queue.shift();
    const res = issueOrder(b, { ...order, side: ai.side }, rules);
    if(res.ok) ai.stats.ordersIssued += 1; else ai.stats.refused += 1;
  }
  if(b.tick < ai.nextEval) return;
  ai.nextEval = b.tick + AI_EVAL_TICKS;
  const delay = AI_REACTION_TICKS[0] + Math.floor(nextRandom(b) * (AI_REACTION_TICKS[1] - AI_REACTION_TICKS[0] + 1));
  const decided = decide(ai, b, rules);
  const pending = new Set(ai.queue.map(q => q.order.unitId));
  for(const order of decided){
    if(pending.has(order.unitId)) continue;
    ai.queue.push({ at: b.tick + delay, order });
  }
  ai.queue.sort((p, q) => p.at - q.at);
}

function ready(b, u, rules){
  return !u.removed && !isBusy(u) && !u.forming && !u.routing && b.tick >= u.cooldownUntil &&
    b.tick >= u.turnedUntil && b.tick >= u.rallyUntil && readiness01(b, u) >= 1 && rules.inChain(b, u);
}

function decide(ai, b, rules){
  const orders = [];
  const mine = b.units.filter(u => !u.removed && u.side === ai.side);
  const foes = b.units.filter(u => !u.removed && u.side !== ai.side && u.type !== 'BRIGADIER' && !u.hidden);
  if(!foes.length) return orders;
  const claimed = new Set();        // squares already chosen this evaluation
  // Orders left in each Brigade's pool this evaluation, so nothing is queued
  // that the pool cannot pay for (it would only be refused at the gate).
  const budget = new Map();
  const canPay = u => { const k = brigadeKey(u); if(!budget.has(k)) budget.set(k, poolOf(b, u).pool.orders); return budget.get(k) > 0; };
  const pay = u => budget.set(brigadeKey(u), budget.get(brigadeKey(u)) - 1);

  // Artillery: keep a lock on the best target; with nothing in its line of
  // fire, optionally move up (never to within two squares of the enemy).
  for(const g of mine){
    if(g.type !== 'ARTILLERY' || g.lock || !ready(b, g, rules) || !canPay(g)) continue;
    const targets = foes.filter(t => rules.canFireAt(b, g, t));
    if(!targets.length){
      if(!ai.tune.gunsAdvance) continue;
      const near = foes.slice().sort((p, q) => dist(p, g) - dist(q, g))[0];
      let best = null, bd = dist(g, near);
      for(const c of rules.reachable(b, g)){
        if(claimed.has(c.x + ',' + c.y) || b.units.some(o => !o.removed && o.x === c.x && o.y === c.y)) continue;
        if(foes.some(f => cheb(f, c) <= 2)) continue;
        const d = dist(c, near) - (b.terrain[c.y][c.x] === 'HILL' ? 0.6 : 0);
        if(d < bd - 0.1){ bd = d; best = c; }
      }
      if(best){ claimed.add(best.x + ',' + best.y); orders.push({ unitId: g.id, type: 'move', target: { x: best.x, y: best.y } }); pay(g); }
      continue;
    }
    targets.sort((p, q) => targetValue(b, rules, g, q) - targetValue(b, rules, g, p));
    orders.push({ unitId: g.id, type: 'fire', targetId: targets[0].id });
    pay(g);
  }

  const brigades = new Map();
  for(const u of mine){ const k = brigadeKey(u); if(!brigades.has(k)) brigades.set(k, []); brigades.get(k).push(u); }
  for(const [, units] of brigades){
    const troops = units.filter(u => u.type !== 'BRIGADIER');
    const brig = units.find(u => u.type === 'BRIGADIER');
    if(!troops.length) continue;
    const cx = troops.reduce((s, u) => s + u.x, 0) / troops.length, cy = troops.reduce((s, u) => s + u.y, 0) / troops.length;
    const centre = { x: cx, y: cy };
    const weakness = f => (b.tick < f.turnedUntil ? 1 : 0) + (rules.inChain(b, f) ? 0 : 1) +
      (foes.some(o => o !== f && cheb(o, f) === 1) ? 0 : 0.5);
    const target = foes.slice().sort((p, q) =>
      (dist(p, centre) - ai.tune.weakTarget * weakness(p)) - (dist(q, centre) - ai.tune.weakTarget * weakness(q)))[0];

    // Threat answers, paid for straight away: foot with enemy cavalry close forms Square.
    for(const u of troops){
      if(!isFoot(u) || !ready(b, u, rules) || u.column || stackPartner(b, u) || !canPay(u)) continue;
      const cavNear = foes.some(f => isCav(f) && cheb(f, u) <= 2);
      if(u.formation !== 'square' && cavNear && !foes.some(f => cheb(f, u) === 1)){ orders.push({ unitId: u.id, type: 'form', formation: 'square' }); pay(u); }
      else if(u.formation === 'square' && !foes.some(f => isCav(f) && cheb(f, u) <= 3)){ orders.push({ unitId: u.id, type: 'form', formation: 'line' }); pay(u); }
    }

    // Bank or spend.
    const movers = troops.filter(u => u.type !== 'ARTILLERY' && u.formation !== 'square' && ready(b, u, rules) && !foes.some(f => cheb(f, u) === 1));
    canPay(troops[0]);
    const left = budget.get(brigadeKey(troops[0]));
    const wave = Math.max(1, Math.ceil(movers.length * ai.tune.waveShare));
    if(movers.length && left >= Math.min(wave, movers.length)){
      ai.stats.waves += 1;
      // Rear units first, so the line closes up rather than strings out.
      movers.sort((p, q) => cheb(q, target) - cheb(p, target));
      let spend = left;
      const planned = new Map(units.map(u => [u.id, { x: u.x, y: u.y }]));
      for(const u of movers){
        if(spend <= 0) break;
        const dest = bestSquare(b, rules, u, target, units, planned, foes, claimed, ai.tune);
        if(!dest) continue;
        claimed.add(dest.x + ',' + dest.y);
        planned.set(u.id, dest);
        orders.push({ unitId: u.id, type: 'move', target: dest });
        spend -= 1; pay(u);
      }
    }

    // The Brigadier: to the square beside the most of his own units, nudged toward the front.
    if(brig && ready(b, brig, rules)){
      // Anyone cut off from the chain is who he goes to fetch first.
      const lost = troops.filter(u => !rules.inChain(b, u));
      const anchor = lost.length ? lost.sort((p, q) => dist(p, brig) - dist(q, brig))[0] : { x: cx, y: cy };
      let best = null, bestScore = scoreBrigadier(brig, troops, target, anchor);
      for(const c of rules.reachable(b, brig)){
        if(claimed.has(c.x + ',' + c.y)) continue;
        const sc = scoreBrigadier(c, troops, target, anchor);
        if(sc > bestScore + 0.01){ bestScore = sc; best = c; }
      }
      if(best){ claimed.add(best.x + ',' + best.y); orders.push({ unitId: brig.id, type: 'move', target: { x: best.x, y: best.y } }); }
    }
  }
  return orders;
}

/* Beside as many of his own units as possible, drawn toward the one he must
   fetch (or the middle of his Brigade), a little toward the front, never
   into contact himself (he escorts, never engages). */
function scoreBrigadier(c, troops, target, anchor){
  const beside = troops.filter(u => cheb(u, c) === 1).length;
  const tooClose = cheb(c, target) <= 1 ? 3 : 0;
  return beside * 2 - dist(c, anchor) * 0.8 - dist(c, target) * 0.1 - tooClose;
}

/* Where one unit should go: closer to the target, next to a Brigade mate or
   its Brigadier (where they will be), onto good ground if it can. A square
   beside the enemy is a chosen fight: taken when the unit can win it. */
function bestSquare(b, rules, u, target, brigade, planned, foes, claimed, tune = AI_DEFAULTS){
  const here = dist(u, target);
  let best = null, bestScore = Infinity;
  for(const c of rules.reachable(b, u)){
    const k = c.x + ',' + c.y;
    if(claimed.has(k)) continue;
    if(b.units.some(o => !o.removed && o.x === c.x && o.y === c.y)) continue;
    const d = dist(c, target);
    if(d >= here - 0.1) continue;                            // only moves that close the distance
    const linked = brigade.some(o => o.id !== u.id && !o.removed && cheb(planned.get(o.id) || o, c) === 1);
    const touching = foes.filter(f => cheb(f, c) === 1);
    let score = d + (linked ? 0 : 2.5) + (TERRAIN_PREF[b.terrain[c.y][c.x]] || 0);
    if(touching.length > 1) score += 1.5;                    // do not walk into two fights at once
    if(tune.gangUp && touching.length === 1 && Object.values(b.fights).some(f => f.a === touching[0].id || f.d === touching[0].id)) score -= tune.gangUp;
    if(touching.length && u.type === 'LIGHT_CAV' && touching.some(f => f.formation === 'square')) score += 3;
    if(score < bestScore){ bestScore = score; best = { x: c.x, y: c.y }; }
  }
  return best;
}

function targetValue(b, rules, g, t){
  let v = 10 - cheb(g, t);
  if(stackPartner(b, t) || t.column) v += 4;                 // a roundshot takes both
  if(!rules.inCover(b, t)) v += 2;
  if(t.formation === 'square') v += 1;
  if(t.type === 'ARTILLERY') v += 1;
  return v;
}
