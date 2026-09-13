/* Confirms the headless environment still loads the whole game. Run after any
   change to module imports: if this breaks, the harness cannot run. */
import { loadGame } from './headless-env.mjs';
const g = await loadGame();
const counts = Object.entries(g).filter(([k])=>k!=='dom')
  .map(([k,v])=>`${k}:${Object.keys(v).length}`);
console.log('headless load OK —', counts.join(' '));
console.log('board:', g.data.COLS + 'x' + g.data.ROWS, '| FAST_DICE_MODE available:', typeof g.dice.setFastDiceMode === 'function');
