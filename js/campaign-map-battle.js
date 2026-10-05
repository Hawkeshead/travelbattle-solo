/* =========================================================
   CAMPAIGN MAP, PHASE 1: FIGHTING A MAP BATTLE ON THE TACTICAL BOARD

   The bridge between the map (campaign-map-core.js) and the existing battle
   engine, which is used unchanged: the same rules, the same battle AI, the
   same end screen and the same match export. This module only decides what
   goes on the board and reads back what happened.

   WHAT IS FIELDED. Exactly the brigades and surviving units of the armies in
   the battle (core makeBattle), each unit keeping its campaign name. Britain
   is the player and red, France the AI and blue, as everywhere else.

   WHICH BOARD. One brigade on the larger side: the 10 x 10 Operation board.
   Two or three: the full 20 x 10 board.

   WHICH GROUND. A town with a historical site (Famars, Hondschoote, Tourcoing
   battles; Lincelles, Caesar's Camp, Beaumont, Willems Operations) uses that
   card's authored map. Those maps come in one size each (the Battles 20 wide,
   the Operations 10 wide), and the brigade count can ask for the other size,
   so:
     - the right size: the site's map as drawn;
     - a 20-wide site on a 10 x 10 fight: the middle ten columns of it;
     - a 10-wide site on a full-board fight: the site in the middle ten
       columns, with the flanks built from the town's terrain profile.
   Any other town gets a board built from its terrainProfile (grass, farm,
   woods, hills, buildings) using the existing square types. Generated boards
   keep both deployment zones (two rows each side) open ground.

   WHO WINS. The standard match condition, which is "two of three Brigades
   broken", i.e. more than half a side's Brigades. A map battle can field one
   or two Brigades a side, so the same rule is applied as "more than half":
   one Brigade breaks it for a one-Brigade side, both for a two-Brigade side,
   two of three as standard (engine-rules checkMapBattleWin). Operation
   objectives are not used: state.scenario stays null.

   DEPLOYMENT. Both armies start on their own two rows (Britain bottom,
   France top, as in every match) in brigade blocks, and the player can
   rearrange before Begin Battle, as in an Operation. Attacker and defender
   do not change edges. NOTE: the standard board favours whoever deploys
   north (France), measured at about 61/39. That is not corrected here; it is
   flagged to Matthew as a design question.
========================================================= */
import { SIDES, TB_DATA, assignBuildingStyles, assignGrassStyles, setBoardMode, state } from './data-core.js';
import { log, newUnit, resetHistoricalIdentities, resetUndoStack } from './engine-state.js';
import { authoredTerrain, redrawOperation } from './operations.js';
import { getCard } from './scenario-cards.js';
import { offerBeginBattle } from './ui-deployment.js';
import { battleBrigades, townById } from './campaign-map-core.js';

const ENGINE_SIDE = { british: SIDES.RED, french: SIDES.BLUE };
export const CM_SIDE = { [SIDES.RED]: 'british', [SIDES.BLUE]: 'french' };

/* ---------- the ground ---------- */
/* A small seeded generator, so a battle relaunched from a save (the app was
   closed before it began) gets the same ground. */
function rng(seedText){
  let h = 1779033703 ^ seedText.length;
  for(let i = 0; i < seedText.length; i++){ h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const PROFILE_SQUARE = { farm: 'PLOUGHED_FIELD', woods: 'WOODS', hills: 'HILL', buildings: 'BUILDING' };
/* How much of the middle ground the profile's features take. Below 1 so a
   town that is "30% buildings" is a village to fight over rather than a
   board with nowhere to stand. */
const FEATURE_SHARE = 0.7;

/* Fills columns [x0, x1) of the middle rows of `grid` from a profile. */
function fillFromProfile(grid, profile, x0, x1, rand){
  const rows = grid.length;
  const middle = [];
  for(let y = 2; y < rows - 2; y++) for(let x = x0; x < x1; x++) middle.push({ x, y });
  const total = Object.values(profile || {}).reduce((a, b) => a + b, 0) || 100;
  for(const [key, square] of Object.entries(PROFILE_SQUARE)){
    let want = Math.round(middle.length * ((profile && profile[key]) || 0) / total * FEATURE_SHARE);
    let guard = 200;
    while(want > 0 && guard-- > 0){
      const open = middle.filter(c => grid[c.y][c.x] === 'OPEN');
      if(!open.length) return;
      // A cluster of two to five squares, grown from a random open square.
      const seed = open[Math.floor(rand() * open.length)];
      const cluster = [seed];
      const size = Math.min(want, 2 + Math.floor(rand() * 4));
      grid[seed.y][seed.x] = square; want--;
      while(cluster.length < size && want > 0){
        const from = cluster[Math.floor(rand() * cluster.length)];
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: from.x + dx, y: from.y + dy }))
          .filter(c => c.y >= 2 && c.y < rows - 2 && c.x >= x0 && c.x < x1 && grid[c.y][c.x] === 'OPEN');
        if(!n.length) break;
        const c = n[Math.floor(rand() * n.length)];
        grid[c.y][c.x] = square; cluster.push(c); want--;
      }
    }
  }
}

/* The terrain grid for a battle at `town`, plus a note of how it was made. */
export function buildBattleTerrain(town, boardMode, seedText){
  const cols = boardMode === 'single' ? 10 : 20, rows = 10;
  const rand = rng(seedText || town.id);
  const blank = () => Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'OPEN'));
  const card = town.historicalSiteId ? getCard(town.historicalSiteId) : null;
  const site = card && card.map && card.map.type === 'authored' ? authoredTerrain(card.map.terrain) : null;
  if(site && site.length === rows){
    const w = site[0].length;
    if(w === cols) return { terrain: site, source: `historical site ${card.name}, as drawn` };
    if(w === 20 && cols === 10) return { terrain: site.map(r => r.slice(5, 15)), source: `historical site ${card.name}, middle ten columns` };
    if(w === 10 && cols === 20){
      const g = blank();
      fillFromProfile(g, town.terrainProfile, 0, 5, rand);
      fillFromProfile(g, town.terrainProfile, 15, 20, rand);
      for(let y = 0; y < rows; y++) for(let x = 0; x < 10; x++) g[y][x + 5] = site[y][x];
      return { terrain: g, source: `historical site ${card.name} in the middle, flanks from ${town.name}'s profile` };
    }
  }
  const g = blank();
  fillFromProfile(g, town.terrainProfile, 0, cols, rand);
  return { terrain: g, source: `built from ${town.name}'s terrain profile` };
}

/* ---------- placing the armies ---------- */
const FRONT = new Set(['GUARD', 'INFANTRY', 'HEAVY_CAV', 'LIGHT_CAV']);
const legalOn = (terrain, type, x, y) => {
  const t = TB_DATA.unitTypes.terrainTypes[terrain[y][x]];
  return !(t && t.restrictTo && !t.restrictTo.includes(type));
};

/* Brigade blocks on a side's two rows, centred, left to right in order:
   foot and horse in the front row, the Brigadier and guns behind, so each
   Brigade starts in its own chain. A square the unit may not stand on (woods
   for horse and guns, buildings for horse) is skipped for the nearest legal
   one on the side's rows. Returns [{ type, x, y, brigadeId, unit }]. */
export function placeSide(terrain, side, brigades){
  const rows = terrain.length, cols = terrain[0].length;
  const [front, back] = side === SIDES.RED ? [rows - 2, rows - 1] : [1, 0];
  const taken = new Set();
  const widths = brigades.map(b => Math.max(b.units.filter(u => FRONT.has(u.type)).length, b.units.filter(u => !FRONT.has(u.type)).length));
  const total = widths.reduce((a, b) => a + b, 0) + (brigades.length - 1);
  let x0 = Math.max(0, Math.floor((cols - total) / 2));
  const out = [];
  const nearestFree = (type, wantX, wantY) => {
    const cells = [];
    for(const y of [wantY, wantY === front ? back : front]) for(let x = 0; x < cols; x++) cells.push({ x, y, d: Math.abs(x - wantX) * 2 + (y === wantY ? 0 : 1) });
    cells.sort((a, b) => a.d - b.d);
    return cells.find(c => !taken.has(c.x + ',' + c.y) && legalOn(terrain, type, c.x, c.y)) || null;
  };
  brigades.forEach((b, bi) => {
    const w = widths[bi];
    const fronts = b.units.filter(u => FRONT.has(u.type));
    // Brigadier in the middle of the back row, guns either side of him.
    const backs = b.units.filter(u => !FRONT.has(u.type)).sort((p, q) => (p.type === 'BRIGADIER') - (q.type === 'BRIGADIER'));
    const backOrder = [];
    backs.forEach((u, i) => (i % 2 ? backOrder.unshift(u) : backOrder.push(u)));
    const place = (u, x, y) => {
      const c = nearestFree(u.type, x, y);
      if(!c) throw new Error(`no square for ${u.type} on ${side}'s rows`);
      taken.add(c.x + ',' + c.y);
      out.push({ type: u.type, x: c.x, y: c.y, brigadeId: bi, unit: u });
    };
    fronts.forEach((u, i) => place(u, Math.min(cols - 1, x0 + i), front));
    const bStart = x0 + Math.floor((w - backOrder.length) / 2);
    backOrder.forEach((u, i) => place(u, Math.min(cols - 1, bStart + i), back));
    x0 += w + 1;
  });
  return out;
}

/* ---------- starting the battle ---------- */
/* Sets the board up for the campaign's pending battle and puts both armies
   on it, ready for Begin Battle. */
export function setupMapBattle(c, map){
  const battle = c.pendingBattle;
  if(!battle) throw new Error('no battle pending');
  const town = townById(map, battle.townId);
  const ground = buildBattleTerrain(town, battle.boardMode, c.id + ':' + battle.id);

  state.scenario = null;
  state.campaign = null;
  state.campaignRun = null;
  state.group = null;
  state.scenarioResult = null; state.scenarioRounds = []; state.scenarioStreaks = {};
  state.gameOver = false; state.winner = null; state._endDeferred = false;
  state.turnNumber = 1;
  state.mode = 'ai'; state.spectate = false;
  state.aiSide = ENGINE_SIDE[c.aiSide];
  state.aiDifficulty = 'hard';

  setBoardMode(battle.boardMode);
  state.boardAssignment = null; state.boardRotation = null;
  state.terrain = ground.terrain;
  state.grassStyles = assignGrassStyles(state.terrain);
  state.buildingStyles = assignBuildingStyles(state.terrain);
  state.excludedRoadEdges = new Set();

  resetHistoricalIdentities();
  resetUndoStack();
  state.units = [];
  const counts = {};
  for(const cmSide of ['british', 'french']){
    const side = ENGINE_SIDE[cmSide];
    const brigades = battleBrigades(c, battle, cmSide).map(x => x.brigade);
    counts[side] = brigades.length;
    for(const p of placeSide(state.terrain, side, brigades)){
      const u = newUnit(side, p.type, p.x, p.y, p.brigadeId);
      u.historicalName = p.unit.name;
      u.historicalBio = bioFor(side, p.unit) || u.historicalBio;
      u.campaignUnitId = p.unit.id;
      state.units.push(u);
    }
  }
  state.mapBattle = {
    campaignId: c.id, battleId: battle.id, turn: battle.turn, date: battle.date,
    townId: battle.townId, townName: town.name, attackerSide: battle.attackerSide,
    brigadeCount: counts, ground: ground.source,
  };
  state.phase = 'deploy';
  state.deployPool = { red: [], blue: [] };
  state.deployBrigadeIndex = { red: counts[SIDES.RED], blue: counts[SIDES.BLUE] };
  log(`Campaign battle at ${town.name}, ${battle.date} (turn ${battle.turn}). ${battle.attackerSide === 'british' ? 'Britain' : 'France'} attacks. Ground: ${ground.source}.`, 'system');
  return state.mapBattle;
}
function bioFor(side, unit){
  const list = (TB_DATA.unitArchive[side] && TB_DATA.unitArchive[side][unit.type]) || [];
  const hit = list.find(e => e.name === unit.name);
  return hit ? hit.bio : null;
}

/* Starts the pending battle on screen: board drawn, armies in place, Begin
   Battle offered. startAmbient is passed in (it lives in ui-menus). */
export function launchMapBattle(c, map, startAmbient){
  setupMapBattle(c, map);
  document.documentElement.classList.add('title-away');
  document.getElementById('overlay').classList.remove('show');
  redrawOperation();
  if(startAmbient) startAmbient();
  offerBeginBattle();
  log('Arrange your units if you wish: drag one to another square on your own rows, or onto another of your units to swap them. Then Begin Battle.', 'system');
}

/* What the board says happened, in campaign terms: the winner and the
   campaign ids of every unit that did not survive. */
export function readBattleOutcome(winner){
  const lost = state.units.filter(u => u.removed && u.campaignUnitId).map(u => u.campaignUnitId);
  return { winner: CM_SIDE[winner], lost };
}
