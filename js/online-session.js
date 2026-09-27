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
