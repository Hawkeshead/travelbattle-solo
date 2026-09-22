/* =========================================================
   ARMY PLAN AUDIT

   Stage A's confirmation, done by machine. Checking the plan by playing a match
   and remembering what happened is a 40-minute job with a bad memory attached;
   this plays matches headless, reads the plan the AI issued at every turn, and
   tests each claim against the board as it actually stood at that moment.

   WHAT IT TESTS, and why each one can fail:

     A  Is the primary target one of the two enemy Brigades with the fewest
        units? An INDEPENDENT sanity check. The plan ranks by toughness minus
        our superiority, which is a different sum, so this is allowed to
        disagree sometimes. If it disagrees often, the sum is drifting away from
        "easiest to break" in plain terms and wants looking at.

     B  Is the Brigade given FIX the one actually closest to the non-target?
        That is the job: pin the Brigade the army has decided not to attack.
        Sending a distant Brigade to do it wastes the turns the plan exists to
        save.

     C  Is the strongest Brigade ever given FIX? It must never be. Hitting
        softly on purpose is the one outright error this design can make, and
        it did make it before this check existed.

     D  Does the plan revise after a Brigade breaks? A plan that outlives the
        army it was written for is not a plan.

     E  Do the roles point at Brigades that are still alive?

   Usage:  node tools/sim/army-plan-audit.mjs [matches] [--verbose]
========================================================= */
import { loadGame, collapseTimers } from './headless-env.mjs';
import { execFileSync } from 'node:child_process';
const realSetInterval = globalThis.setInterval;

const N = Number(process.argv[2] || 6);
const VERBOSE = process.argv.includes('--verbose');

/* ONE MATCH PER PROCESS. Several matches in one process contaminate each other:
   the modules are shared, so board state leaks from one seed into the next. The
   same fault made term-report give a 47-turn match 21 sampled moves and a
   "finished" match on turn 1. Caught here by the same seeds reporting 19 plans
   on one run and 14 on the next. The parent spawns a child per seed and adds up
   what they return. */
const CHILD = process.argv.indexOf('--seed');
if (CHILD === -1) {
  const total = { plans: 0, revisions: 0, A: 0, Aof: 0, B: 0, Bof: 0, Bstrong: 0, C: 0, D: 0, Dof: 0, E: 0 };
  const all = [];
  for (let seed = 1; seed <= N; seed++) {
    const out = execFileSync(process.execPath,
      [new URL(import.meta.url).pathname, '1', '--seed', String(seed), ...(VERBOSE ? ['--verbose'] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const line = out.trim().split('\n').filter(Boolean).pop();
    const res = JSON.parse(line);
    for (const k of Object.keys(total)) total[k] += res.tally[k] || 0;
    all.push(...res.notes);
  }
  const pc = (a, b) => b ? `${Math.floor(a * 1000 / b) / 10}%` : 'n/a';
  console.log(`\n=== ARMY PLAN AUDIT — ${N} matches ===\n`);
  console.log(`plans issued                       ${total.plans} (${total.revisions} of them revisions)`);
  console.log(`A primary target among the two smallest enemy Brigades   ${total.A}/${total.Aof}  ${pc(total.A, total.Aof)}`);
  console.log(`B FIX given to the Brigade nearest the non-target        ${total.B}/${total.Bof}  ${pc(total.B, total.Bof)}` +
    (total.Bstrong ? `  (${total.Bstrong} where the nearest was the strongest, passed over by design)` : ''));
  console.log(`C FIX given to the STRONGEST Brigade (must be 0)         ${total.C}`);
  console.log(`D plan revised within 2 turns of a Brigade breaking      ${total.D}/${total.Dof}  ${pc(total.D, total.Dof)}`);
  console.log(`E role aimed at a Brigade with no units (must be 0)      ${total.E}`);
  if (all.length) {
    console.log(`\nDISAGREEMENTS AND FAULTS (first 12 of ${all.length}):`);
    for (const n of all.slice(0, 12)) console.log('  ' + n);
  }
  process.exit(total.C > 0 || total.E > 0 ? 1 : 0);
}
const ONLY_SEED = Number(process.argv[CHILD + 1]);

const tally = { plans: 0, revisions: 0, A: 0, Aof: 0, B: 0, Bof: 0, Bstrong: 0, C: 0, D: 0, Dof: 0, E: 0 };
const notes = [];

for (let seed = ONLY_SEED; seed <= ONLY_SEED; seed++) {
  const g = await loadGame();
  const render = await import('../../js/render-board.js');
  const menus = await import('../../js/ui-menus.js');
  const ai = await import('../../js/ai-strategy.js');
  collapseTimers();
  const { data, dice, rules } = g; const { state, SIDES } = data;
  dice.setFastDiceMode(true); render.setFastAnimationMode(true);
  state.scenario = null; state.campaign = null; state.mode = 'ai'; state.spectate = true;
  state.aiDifficulty = 'hard'; state.aiSide = SIDES.RED; state.gameOver = false; state.winner = null;
  rules.seedRng(seed);

  const seen = {};           // side -> last plan signature reported
  /* The hook fires at the END of a turn, but a plan is made at its START, so a
     Brigade destroyed during the turn would look like a target the plan should
     have known was dead. Every check judges the plan against the board as it
     stood at the previous hook, which is when it was written. */
  const before = {};         // side -> { live, sizes } as at the previous hook
  const broke = {};          // side -> turn its last Brigade break was seen
  const alive = {};          // side -> live Brigade ids last turn

  globalThis.__fcTurnHook = st => {
    for (const side of [SIDES.RED, SIDES.BLUE]) {
      const enemy = side === SIDES.RED ? SIDES.BLUE : SIDES.RED;
      const fighters = (s, b) => st.units.filter(u => !u.removed && u.side === s &&
        u.brigadeId === b && u.type !== 'BRIGADIER');
      const live = s => [0, 1, 2].filter(b => fighters(s, b).length > 0);

      // Note a break on either side, so revision can be checked next turn.
      const nowAlive = live(side).join(',') + '|' + live(enemy).join(',');
      if (alive[side] !== undefined && alive[side] !== nowAlive) broke[side] = st.turnNumber;
      alive[side] = nowAlive;

      const priorLive = before[side];
      before[side] = { live: live(enemy), sizes: live(enemy).map(b => ({ b, n: fighters(enemy, b).length })) };

      const entry = st._aiArmyPlan && st._aiArmyPlan[side];
      if (!entry) continue;
      const plan = entry.plan;
      const key = entry.signature + ':' + plan.turn;
      if (seen[side] === key) continue;
      const first = seen[side] === undefined;
      seen[side] = key;
      tally.plans++;
      if (!first) tally.revisions++;

      // A: primary target among the two smallest enemy Brigades by unit count.
      const sizes = (priorLive ? priorLive.sizes : live(enemy).map(b => ({ b, n: fighters(enemy, b).length })))
        .slice().sort((x, y) => x.n - y.n);
      if (sizes.length >= 2) {
        tally.Aof++;
        if (sizes.slice(0, 2).some(s => s.b === plan.targets[0])) tally.A++;
        else notes.push(`seed ${seed} T${plan.turn} ${side}: primary was enemy Bde ${plan.targets[0] + 1} ` +
          `(${(sizes.find(x => x.b === plan.targets[0]) || { n: 0 }).n} units), smallest were ` +
          sizes.slice(0, 2).map(s => `Bde ${s.b + 1} (${s.n})`).join(' and '));
      }

      const roles = Object.entries(plan.roles).map(([b, r]) => ({ b: Number(b), ...r }));
      const fix = roles.find(r => r.role === 'FIX');

      // B: FIX given to the Brigade closest to the non-target.
      if (fix && plan.nonTarget != null && live(side).length > 2) {
        const foes = fighters(enemy, plan.nonTarget);
        const dist = b => {
          let d = Infinity;
          for (const a of fighters(side, b)) for (const f of foes)
            d = Math.min(d, Math.max(Math.abs(a.x - f.x), Math.abs(a.y - f.y)));
          return d;
        };
        const ranked = live(side).map(b => ({ b, d: dist(b) })).sort((x, y) => x.d - y.d);
        const strongest = plan.own[0] && plan.own[0].id;
        /* Ties count as a pass: equal distance is not a worse choice. And the
           nearest Brigade being the STRONGEST is the design working, not
           failing, so it is reported separately rather than as a miss. */
        tally.Bof++;
        if (ranked[0] && dist(fix.b) <= ranked[0].d) tally.B++;
        else if (ranked[0] && ranked[0].b === strongest) { tally.B++; tally.Bstrong++;
          notes.push(`seed ${seed} T${plan.turn} ${side}: nearest to the non-target was Bde ${ranked[0].b + 1} ` +
            `(${ranked[0].d} away) but it is the strongest, so FIX went to Bde ${fix.b + 1} (${dist(fix.b)} away) — by design`);
        } else notes.push(`seed ${seed} T${plan.turn} ${side}: FIX went to Bde ${fix.b + 1} (${dist(fix.b)} away), ` +
          `nearest to the non-target was Bde ${ranked[0].b + 1} (${ranked[0].d} away)`);
      }

      // C: the strongest Brigade must never be given FIX.
      if (fix) {
        const strongest = plan.own[0] && plan.own[0].id;
        if (fix.b === strongest && plan.own.length > 1) {
          tally.C++;
          notes.push(`seed ${seed} T${plan.turn} ${side}: FIX given to the STRONGEST Brigade ${fix.b + 1}`);
        }
      }

      // E: every role points at an enemy Brigade that still exists.
      for (const r of roles) {
        const wasAlive = priorLive ? priorLive.live.includes(r.target) : fighters(enemy, r.target).length > 0;
        if (r.target == null || !wasAlive) {
          tally.E++;
          notes.push(`seed ${seed} T${plan.turn} ${side}: ${r.role} aimed at enemy Bde ` +
            `${r.target == null ? 'none' : r.target + 1}, which already had no units when the plan was written`);
        }
      }

      // D: a break should be followed by a revision within a turn or two.
      if (broke[side] != null && !first && plan.turn - broke[side] <= 2) { tally.D++; tally.Dof++; broke[side] = null; }
      else if (broke[side] != null && plan.turn - broke[side] > 2) { tally.Dof++; broke[side] = null; }

      if (VERBOSE) console.log(`seed ${seed} T${plan.turn} ${side}: ` +
        roles.map(r => `${r.role}=Bde${r.b + 1}->${r.target + 1}`).join(' '));
    }
  };

  menus.beginBoardSetup();
  await new Promise(r => { const p = realSetInterval(() => {
    if (state.gameOver || state.turnNumber > 400) { clearInterval(p); r(); } }, 20); });
  globalThis.__fcTurnHook = null;
  process.stderr.write(`  seed ${seed} done (turn ${state.turnNumber})\n`);
}

console.log(JSON.stringify({ tally, notes }));
process.exit(0);
