/* =========================================================
   ONLINE SESSION FLAG

   Deliberately tiny and dependency-free, because the battle code imports it
   statically and must not pull the Supabase client (a network download) into
   every game. js/online.js, loaded only when someone chooses to play online,
   is what sets it.

   While a session is set, the game runs as a match against "the AI" with
   aiSide pointed at the OTHER PLAYER. Everything the game already does for an
   AI side then applies unchanged: input is locked on their turn, the board is
   flipped for whoever plays France, their hidden ambushes stay hidden. The one
   difference is that the AI never acts for that side: its moves arrive over
   the connection instead. That single rule is what isOnline() guards.
========================================================= */
let session = null;

export function isOnline(){ return !!session; }
export function onlineSession(){ return session; }
export function setOnlineSession(s){ session = s; }

/* When the game would hand deployment to the AI for the other player's side,
   online play asks the other phone instead. online.js registers the handler;
   ai-deployment calls requestRemoteDeploy rather than choosing for them. */
let remoteDeployHandler = null;
export function setRemoteDeployHandler(fn){ remoteDeployHandler = fn; }
export function requestRemoteDeploy(side){ if(remoteDeployHandler) remoteDeployHandler(side); }

/* A question for the other player: a re-roll, a Leadership Roll, an ambush.
   The phone running the rules asks, the other phone shows the same choice its
   own player would see, and the answer comes back. If none arrives in time
   (they have put the phone down, or lost signal) the fallback is used, which is
   what the game would have chosen for them anyway. */
let remoteAsker = null;
export function setRemoteAsker(fn){ remoteAsker = fn; }
/* Group (2v2) online: whether a unit's decision belongs to another phone
   depends on which ARMY it is in, so the session can supply its own test and
   the unit is passed along. */
export function isRemoteSide(side, unit){
  if(!session) return false;
  if(session.isRemote) return session.isRemote(side, unit);
  return side === session.remoteSide;
}
export function askRemote(kind, data, fallback, timeoutMs){
  if(!remoteAsker) return Promise.resolve(fallback);
  return remoteAsker(kind, data, fallback, timeoutMs);
}

/* =========================================================
   SHARED ARMIES (js/online-shared.js): two players command one army, each
   with their own Brigades. Every hook below is inert unless the session
   supplies it, so 1v1 (online.js) and the four-army 2v2 (online-group.js)
   behave exactly as before.

   - ownsUnit(u): may this phone give this unit orders? (its Brigade's
     commander is this player, or an absent partner's Brigades have passed
     to them). Looking at a unit is always allowed.
   - interceptOrder(kind, data): a Move-phase order on a phone that is not
     the referee is sent to the referee instead of being carried out here;
     true means it was taken. Also catches Done and Undo.
   - aiAllowedOnline(): only the phone that runs the AI (the host, in Co-op
     against the AI) lets it act.
   - asksElsewhere(unit): a question about this unit (re-roll, Leadership,
     ambush) belongs to another phone even though this phone's side is
     acting (a partner's Brigade).
   - holdsAutoEnd(): the phase does not end itself while partners are still
     giving orders; Done does it.
   - commanderNote(u): who commands this unit, for the unit card; null when
     there is nothing to say.
========================================================= */
export function ownsUnit(u){
  if(!session) return !local || !u || local.ownsUnit(u);
  return !session.ownsUnit || !u ? true : session.ownsUnit(u);
}
export function interceptOrder(kind, data){
  if(!session) return !!(local && local.interceptOrder(kind, data));
  return !!(session.interceptOrder && session.interceptOrder(kind, data));
}
export function aiAllowedOnline(side){ return !session || (!!session.runsAi && session.runsAi(side)); }
export function asksElsewhere(unit){
  if(!session) return !!(local && unit && local.asksElsewhere(unit));
  if(!session.shared || !unit) return false;
  // Not this phone's person to decide: a partner's unit, or one the AI partner commands.
  if(session.asksElsewhere) return session.asksElsewhere(unit);
  return !!(session.isRemote && session.isRemote(unit.side, unit));
}
/* FRIENDLY AI ON THIS PHONE (js/friendly-ai.js): in a Quick Battle the player
   may hand some of their own Brigades to an AI commander. With no online
   session, ownsUnit, interceptOrder and asksElsewhere ask it instead; it
   answers exactly as before when no Brigade is handed over. */
let local = null;
export function setLocalCommand(hooks){ local = hooks; }
export function holdsAutoEnd(){ return !!(session && session.holdsAutoEnd && session.holdsAutoEnd()); }
export function commanderNote(u){
  if(!session) return local && u ? local.commanderNote(u) : null;
  return session.commanderNote ? session.commanderNote(u) : null;
}
export function partnerRing(u){ return session && session.partnerRing ? session.partnerRing(u) : null; }

/* Shared armies (online-shared.js) are behind a flag while they are reviewed:
   offered only after ?sharedArmies=1, remembered for the tab. */
const SHARED_FLAG = 'fc-shared-armies';
export function sharedArmiesEnabled(){
  try {
    if(new URLSearchParams(location.search).get('sharedArmies') === '1') sessionStorage.setItem(SHARED_FLAG, '1');
    return sessionStorage.getItem(SHARED_FLAG) === '1';
  } catch { return false; }
}
