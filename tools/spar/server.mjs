/* =========================================================
   SPARRING SERVER (19 Oct 2026)

   A live headless game in which one side is played from outside (by Claude,
   or a script) through the same board taps and buttons a player uses, and
   the other side by the game's AI. For finding out what good play looks
   like against the AI we are building.

   Start:  SPAR_CARD=waterloo-ligny-prussia SPAR_SIDE=blue SPAR_SEED=701 \
           node tools/spar/server.mjs            (listens on 127.0.0.1:4180)

   GET  /state            the board as text, whose turn and phase, my units,
                          objectives, and the last log lines
   GET  /moves?x=&y=      tap my unit at (x, y): the squares and targets it
                          lights up (then tap one of them to act)
   POST /tap?x=&y=        a board tap, exactly as a player's finger
   POST /order?name=      a unit order button: square, ambush, charge, marchOff
   POST /end              end the current phase
   GET  /log?n=           the battle log

   After every request the server lets the game run: dice for my side are
   rolled for me, prompts get their default answer, and the AI plays its
   whole turn, until it is my turn again or the battle is over.
========================================================= */
import http from 'node:http';
import { loadGame, collapseTimers } from '../sim/headless-env.mjs';

const CARD = process.env.SPAR_CARD, SIDE = process.env.SPAR_SIDE || 'blue', SEED = Number(process.env.SPAR_SEED || 701);
await loadGame();
collapseTimers();
const { state } = await import('../../js/data-core.js');
const rules = await import('../../js/engine-rules.js');
const ops = await import('../../js/operations.js');
const ui = await import('../../js/ui-battle.js');
const render = await import('../../js/render-board.js');
const ru = await import('../../js/render-units.js');
if(render.setFastAnimationMode) render.setFastAnimationMode(true);
if(rules.seedRng) rules.seedRng(SEED);

ops.setupOperation(CARD, SIDE);
state.mode = 'ai'; state.aiSide = SIDE === 'red' ? 'blue' : 'red'; state.spectate = false;
ui.startBattle();

const doc = globalThis.document;
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Let the game run until it is my move again (or over): roll my dice, take
   default answers, wait out the AI. */
async function settle(limitMs = 60000){
  const t0 = Date.now();
  let quiet = 0;
  while(Date.now() - t0 < limitMs){
    await sleep(5);
    if(state.gameOver) return;
    const begin = doc.getElementById('beginBattleBtn');
    if(begin && begin.style.display !== 'none'){ begin.click(); quiet = 0; continue; }
    const roll = doc.getElementById('diceRollBtn');
    if(roll && roll.style.display !== 'none' && roll.onclick){ roll.onclick(); quiet = 0; continue; }
    const prompt = doc.querySelector('.dice-panel.prompting button.primary, .dice-panel.prompting button');
    if(prompt){ prompt.click(); quiet = 0; continue; }
    const mine = state.turn === SIDE && !state.aiBusy;
    quiet = mine ? quiet + 1 : 0;
    if(quiet > 40) return;
  }
}
const COLS = () => state.terrain[0].length, ROWS = () => state.terrain.length;
const G = { OPEN: '.', FIELD: '.', PLOUGHED_FIELD: ':', WOODS: '*', HILL: '^', BUILDING: '#', ROAD: '=' };
const L = { INFANTRY: 'i', GUARD: 'g', LIGHT_CAV: 'l', HEAVY_CAV: 'h', ARTILLERY: 'a', BRIGADIER: 'b' };
function board(){
  const rows = [];
  rows.push('    ' + Array.from({ length: COLS() }, (_, x) => (x % 10)).join(''));
  for(let y = 0; y < ROWS(); y++){
    let r = '';
    for(let x = 0; x < COLS(); x++){
      const us = state.units.filter(u => !u.removed && u.x === x && u.y === y);
      if(us.length){ const u = us.find(o => o.type !== 'BRIGADIER') || us[0]; const c = L[u.type] || '?'; r += u.side === SIDE ? c.toUpperCase() : c; }
      else r += G[state.terrain[y][x]] || '.';
    }
    rows.push(String(y).padStart(3) + ' ' + r);
  }
  return rows.join('\n');
}
function unitLine(u){
  const flags = [u.formation === 'square' ? 'square' : '', u.turnOnly ? 'turned' : '', u.hidden ? 'ambush' : '', state.moved && state.moved.has(u.id) ? 'moved' : '', rules.isLocked && rules.isLocked(u) ? 'locked' : ''].filter(Boolean).join(',');
  return `${u.id} ${u.type} ${u.historicalName || ''} @${u.x},${u.y} bde${u.brigadeId}${u.storyTag ? ' [' + u.storyTag + ']' : ''}${flags ? ' (' + flags + ')' : ''}`;
}
function snapshot(){
  const sc = state.scenario;
  const water = state.water ? Object.entries(state.water.edges).filter(([, t]) => t !== 'river').map(([k, t]) => `${t}:${k}`).join(' ') : 'none';
  return [
    `round ${Math.ceil((state.turnNumber || 1) / 2)}  turn ${state.turn}  phase ${state.phase}  me=${SIDE}${state.gameOver ? '  GAME OVER' : ''}`,
    sc ? `objective me: ${(sc.win[SIDE === 'red' ? 'british' : 'french'] || {}).text}` : '',
    sc ? `objective AI: ${(sc.win[SIDE === 'red' ? 'french' : 'british'] || {}).text}` : '',
    `achieved: ${JSON.stringify(state.scenarioAchieved || {})}${state.scenarioResult ? '  RESULT: ' + state.scenarioResult.reason : ''}`,
    `crossings: ${water}`,
    board(),
    'legend: upper case = mine, lower case = AI; i inf g guard l light cav h heavy cav a art b brigadier; . open : field * woods ^ hill # village',
    'my units:', ...state.units.filter(u => !u.removed && u.side === SIDE).map(unitLine),
    'enemy units:', ...state.units.filter(u => !u.removed && u.side !== SIDE).map(unitLine),
    'log:', ...logTail(12),
  ].filter(s => s !== '').join('\n');
}
function logTail(n){
  const el = doc.getElementById('log');
  const lines = el ? [...el.querySelectorAll('div, p, li')].map(e => e.textContent.trim()).filter(Boolean) : [];
  return lines.slice(-n);
}

await settle();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = k => url.searchParams.get(k);
  let out = '';
  try {
    if(url.pathname === '/state') out = snapshot();
    else if(url.pathname === '/moves'){
      ui.onCellClick(Number(q('x')), Number(q('y')));
      const hl = ru.highlightCells || (ru.getHighlightCells && ru.getHighlightCells()) || [];
      out = JSON.stringify({ selected: state.selectedUnitId, cells: hl.map(c => [c.x, c.y, c.kind]) });
    }
    else if(url.pathname === '/tap'){ ui.onCellClick(Number(q('x')), Number(q('y'))); await settle(); out = snapshot(); }
    else if(url.pathname === '/order'){
      const id = { square: 'squareBtn', ambush: 'ambushBtn', charge: 'chargeBtn', marchOff: 'marchOffBtn' }[q('name')];
      const b = id && doc.getElementById(id);
      if(b && !b.disabled) b.click(); else out = `order ${q('name')} not available\n`;
      await settle(); out += snapshot();
    }
    else if(url.pathname === '/end'){
      if(state.phase === 'move') ui.endMovePhase(); else if(state.phase === 'fire') ui.endFirePhase(); else if(state.phase === 'fight') ui.endFightPhase();
      await settle(); out = snapshot();
    }
    else if(url.pathname === '/debug') out = JSON.stringify({ mode: state.mode, aiSide: state.aiSide, spectate: state.spectate, friendlyAi: state.friendlyAi, turn: state.turn, phase: state.phase, turnNumber: state.turnNumber, firstPlayer: state.scenario && state.scenario.firstPlayer });
    else if(url.pathname === '/why'){
      const os = await import('../../js/online-session.js'); const grp = await import('../../js/group.js');
      const u = state.units.find(o => !o.removed && o.x === Number(q('x')) && o.y === Number(q('y')));
      out = JSON.stringify({ id: u && u.id, acting: grp.isActing(u), owns: os.ownsUnit(u), legal: u ? rules.legalMoves(u).length : null, moved: u && state.moved && state.moved.has(u.id), movable: u ? rules.movableUnitsForSide(u.side).has(u.id) : null });
    }
    else if(url.pathname === '/log') out = logTail(Number(q('n') || 40)).join('\n');
    else out = 'endpoints: /state /moves?x=&y= /tap?x=&y= /order?name= /end /log?n=';
  } catch(e){ out = 'ERROR ' + (e && e.stack || e); }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(out + '\n');
});
server.listen(Number(process.env.SPAR_PORT || 4180), '127.0.0.1', () => console.log('spar server ready'));
