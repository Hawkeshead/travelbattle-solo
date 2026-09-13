/* =========================================================
   AI-VS-AI RUNNER

   Runs a full match with the AI on both sides, headless, and returns the
   existing match export unchanged.

   HOW BOTH SIDES ARE DRIVEN, and why it needs no change to js/.

   The game already acts automatically whenever `state.turn === state.aiSide`.
   So the harness does not add an AI for Britain: it keeps `state.aiSide` equal
   to whichever side is currently to act. The same scoring, the same weights, the
   same doctrine, only the side flag differs, which is exactly what the brief
   requires for the test to mean anything.

   This is the brief's one permitted addition and it lives entirely here. Nothing
   in js/ is touched, so the human-vs-AI path cannot be affected by it.
========================================================= */
import { loadGame } from './headless-env.mjs';

const SETTLE_POLL_MS = 4;

export async function runOneMatch({ seed, deployFirst, difficulty = 'hard' }, g) {
  const { data, dice, rules, replay } = g;
  const { state } = data;

  dice.setFastDiceMode(true);
  state.mode = 'ai';
  state.aiDifficulty = difficulty;
  state.boardMode = 'standard';
  state.scenario = null;
  state.gameOver = false;

  // Deterministic per match, so any single result can be reproduced.
  rules.seedRng(seed);

  /* The driver. A bare interval that keeps aiSide pointed at the side to act,
     during deployment and during play alike. It reads state and writes one
     field; it makes no decisions and has no opinion about the game. */
  let lastPlaced = -1, idleTicks = 0;
  const driver = setInterval(() => {
    const acting = state.phase === 'deploy' ? state.deployTurn : state.turn;
    if (acting !== undefined && state.aiSide !== acting) state.aiSide = acting;

    /* THE DEPLOYMENT KICK. In the browser the AI's next deploy step is scheduled
       by the previous placement, and a human placement schedules the AI's reply.
       With no UI there is no human placement, so the chain has nothing to
       restart it and deployment stalls with both sides half-placed. The harness
       re-arms it when nothing has been placed for a few ticks. It adds no
       decision: aiDeployStep chooses the square exactly as it always does. */
    if (state.phase === 'deploy') {
      const placed = (state.units || []).length;
      if (placed === lastPlaced) {
        if (++idleTicks > 8) { idleTicks = 0; g.uiDeploy.scheduleAiDeployStep(0); }
      } else { lastPlaced = placed; idleTicks = 0; }
    }
  }, SETTLE_POLL_MS);

  state.aiSide = deployFirst;
  g.uiDeploy.initDeployment(deployFirst);

  const finished = await waitForEnd(state, 60_000);
  clearInterval(driver);

  return {
    seed,
    deployFirst,
    finished,
    export: replay.exportFullMatchLog ? replay.exportFullMatchLog() : null,
    state,
  };
}

/* Resolves when the match reports itself over, or when the wall clock runs out.
   A timeout is a RESULT, not an error: a match that will not end is exactly the
   kind of thing a hundred-seed run exists to find, and it is recorded with its
   seed rather than crashing the run. */
function waitForEnd(state, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (state.gameOver) { clearInterval(poll); resolve('win'); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(poll); resolve('timeout'); return; }
    }, SETTLE_POLL_MS);
  });
}

export async function main() {
  const g = await loadGame();
  const uiDeploy = await import('../../js/ui-deployment.js');
  g.uiDeploy = uiDeploy;
  const { SIDES } = g.data;

  const n = Number(process.argv[2] || 2);
  const results = [];
  for (let i = 0; i < n; i++) {
    const seed = i + 1;
    for (const deployFirst of [SIDES.RED, SIDES.BLUE]) {
      const r = await runOneMatch({ seed, deployFirst }, g);
      results.push(r);
      console.log(`  seed ${seed} deployFirst=${deployFirst}: ${r.finished} turns=${r.state.turnNumber}`);
    }
  }
  console.log(`\n${results.length} matches, ${results.filter(r => r.finished === 'win').length} reached a win condition`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
