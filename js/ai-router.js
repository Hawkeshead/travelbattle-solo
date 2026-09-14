/* =========================================================
   AI ROUTER — which version of the AI is playing this side

   In a played match there is one AI and this file is a pass-through: every
   export below forwards straight to ai-strategy.js and costs a function call.
   Nothing about the game changes.

   It exists so the simulator can put TWO VERSIONS OF THE AI ON ONE BOARD, which
   is the only way to ask whether a new version is actually better than the one
   it replaces. Weight overrides (tune/flag) can only test changes someone
   remembered to wire; this tests the AI as it was actually written, on a given
   commit, against the AI as it is now.

   HOW THE TWO SHARE A BOARD. A second copy of ai-strategy.js is written into
   js/ under a suffixed name, so its relative imports of data-core, engine-rules
   and the rest resolve to the SAME module instances the live game is using.
   That matters: an older copy loaded from another directory would import its own
   data-core and play on a different board entirely, which would look like it was
   working right up until the results made no sense.

   Registration is per side and the router reads state.aiSide, which spectate
   already points at whichever side is acting. Unregistered sides get the current
   AI, so a half-configured run degrades to a normal one rather than failing
   strangely.
========================================================= */
import * as current from './ai-strategy.js';
import { state } from './data-core.js';

const versions = new Map();   // side -> module namespace

/* Called only by the simulator. A null module clears the override. */
export function registerAiVersion(side, mod){
  if(mod) versions.set(side, mod); else versions.delete(side);
}
export function registeredAiVersions(){
  return { red: versions.has('red'), blue: versions.has('blue') };
}
export function clearAiVersions(){ versions.clear(); }

function forSide(side){ return versions.get(side) || current; }
/* The three phase entries take no argument and read state.aiSide themselves, so
   the routing key has to come from the same place they do. */
function acting(){ return forSide(state.aiSide); }

export function aiPlanTurn(side){ return forSide(side).aiPlanTurn(side); }
export function aiDoMovePhase(){ return acting().aiDoMovePhase(); }
export function aiDoFirePhase(){ return acting().aiDoFirePhase(); }
export function aiDoFightPhase(){ return acting().aiDoFightPhase(); }

/* Not routed. These two are read by the UI to describe what it is showing, not
   to decide anything, so they always come from the current build. Routing them
   would mean the debug panel described one version while another moved. */
export { estimateFightValue, missionFor } from './ai-strategy.js';
