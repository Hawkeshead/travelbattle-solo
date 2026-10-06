import { clearFloatingText, initFloatingText } from './floating-text.js';
import { initDeployRearrange } from './deploy-rearrange.js';
import { setAnimatingProbe } from './match-save.js';
import { unitAnimations } from './render-board.js';
import { initFigures } from './render-figures.js';
import { initTelemetrySender } from './telemetry/sender.js';
import { recVisibility } from './telemetry/recorder.js';
import { loadCampaignProgress, resumeCampaignFromStorage } from './campaign.js';
import { fctSquareToPixel, playBoardIntroAnimation, sizeCanvas } from './render-board.js';
import { initDesk } from './render-desk.js';
import { initBattleControls, initBoardInput } from './ui-battle.js';
import { CAMPAIGNS_ENABLED, prepareTitleBoard, showModeSelect, startAmbientLayer } from './ui-menus.js';
import { AudioManager } from './audio-manager.js';
import { initSafeArea } from './safe-area.js';
import { FOOT_ACK, FOOT_ACK_ALT, MUSKET_VOLLEY_TAKES, TURN_THEME, VOLLEY_COMMAND } from './ui-battle.js';
import { RALLY_CALL } from './engine-rules.js';
import { DESPATCH_SOUNDS, initDespatch } from './despatch.js';

/* =========================================================
   BOOT
   The single entry point. Everything above this file defines things;
   this file is the only one that *does* anything at start-up.

   Keeping start-up in one explicit function — rather than spread across
   whichever statements happened to sit at the top level of each file —
   means the order is visible here instead of being an emergent property
   of the script order in index.html.
========================================================= */

export function start(){
  // Input and control wiring first, so the DOM is fully live before any
  // screen is drawn.
  initDesk();
  initBoardInput();
  initBattleControls();

  // Browsers block audio until a real user gesture — unlock on the very
  // first tap/click anywhere, regardless of which button starts the game.
  // Preload the effects a player is likely to trigger almost immediately
  // (selecting/moving a unit) right here too, so the very first click
  // doesn't also pay that effect's one-time fetch+decode cost on top of
  // unlocking — see AudioManager.playEffect's buffer cache.
  document.addEventListener('pointerdown', ()=>{
    AudioManager.unlock();
    /* The menu theme starts on the SAME first gesture that unlocks audio, and
       not before. A browser blocks playback until the player has touched
       something, so showModeSelect below cannot start it on the very first load:
       the call would fail silently and leave the menus quiet all session. This is
       the first-load half; showModeSelect covers every return after that.
    
       Calling it in both places is safe: playMusic replaces the element only when
       the source changes, so the second call re-levels the same track rather than
       restarting or layering it. */
    AudioManager.playMusic('audio/music/menu-musket-tango.mp3');
    /* EVERY effect, not just two. Only the click and the march were preloaded,
       so each of the other eight paid a one-time fetch and decode the first time
       it was needed. That is why a unit had to be selected two or three times
       before its sound arrived: the first tap was fetching the file, not failing.
       They total well under a megabyte and this runs on the first gesture, when
       the player is still on the menus. */
    AudioManager.preloadEffects([
      'audio/effects/chess-piece-placed.wav', 'audio/effects/infantry-marching.wav',
      'audio/effects/guard-march-french.mp3',
      'audio/effects/cavalry-select-sword.wav', 'audio/effects/cavalry-gallop.wav',
      'audio/effects/brigadier-select-attention.wav', 'audio/effects/brigadier-gallop.wav',
      'audio/effects/artillery-select.wav', 'audio/effects/artillery-move.wav',
      'audio/effects/artillery-fire.wav', 'audio/effects/artillery-impact.wav',
      'audio/effects/battle-resolve.wav',   // the fight's bed under the dice: decoded early so the first fight is not silent
      'audio/effects/unit-destroyed.wav',
      /* The volley takes are four seconds each and much the largest effects in
         the set, so they are the ones that would most obviously arrive late if
         fetched on first use. Imported rather than listed again, so the preload
         set cannot drift from what actually plays. */
      ...MUSKET_VOLLEY_TAKES,
      /* Both sides' acknowledgements, flattened. An empty side contributes
         nothing, so this is already correct for the French takes arriving later
         without anyone having to remember to come back here. */
      ...Object.values(FOOT_ACK).flat(),
      ...Object.values(FOOT_ACK_ALT).flat(),
      // The despatch case that ends each phase (despatch.js).
      ...Object.values(DESPATCH_SOUNDS),
      ...Object.values(RALLY_CALL).flat(),
      // The volley order plays first, so it matters most that it is not late.
      ...Object.values(VOLLEY_COMMAND).filter(Boolean).map(c => c.file),
      // Turn themes open every turn, including the very first one.
      ...Object.values(TURN_THEME).filter(Boolean).map(t => t.file),
    ]);
  }, { once:true });

  // Then either resume the campaign in progress or show the title screen.
  //
  // The OPERATIONS_ENABLED check matters as much as withdrawing the menu button:
  // this path runs before any menu is drawn, so a player who already had a
  // campaign saved would otherwise be dropped straight back into a parked
  // feature on every single load, with no route out. The save itself is left
  // alone rather than cleared — it is their progress, and it should still be
  // there when Campaigns come back.
  /* 4 Oct 2026: Campaigns are back, played through campaign-play.js and its
     own progress (fc_campaign_v2), entered from the Campaigns menu, never by
     auto-resume. The old format's save (tbCampaignProgress, the retired
     campaign.js) is never resumed: its flow no longer exists. It is left in
     storage, untouched. An unfinished campaign battle comes back through the
     start screen's Resume Battle, like any other. */
  const savedCampaignProgress = null;
  void CAMPAIGNS_ENABLED; void loadCampaignProgress;
  /* THE CAMPAIGN MAP opens every battle, and returns from it, on a fresh page
     (as New Battle always has), so no state from one fight leaks into the
     next. It leaves a one-shot note in sessionStorage saying where to land:
     'battle' (start the pending battle) or 'map'. No title intro then. */
  let campaignMapLanding = null;
  try { campaignMapLanding = sessionStorage.getItem('fc_cmap_launch'); sessionStorage.removeItem('fc_cmap_launch'); } catch { /* no storage: the title screen as usual */ }
  if(campaignMapLanding){
    document.documentElement.classList.add('title-away');
    prepareTitleBoard();
    sizeCanvas();
    import('./campaign-map-ui.js').then(m => m.landAfterReload(campaignMapLanding));
  } else if(savedCampaignProgress){
    resumeCampaignFromStorage(savedCampaignProgress);
  } else {
    /* THE TITLE SCREEN (4 Oct 2026): a battlefield falls into place, the
       clouds come in, then the menu appears along the bottom. */
    prepareTitleBoard();
    sizeCanvas();
    playBoardIntroAnimation(()=>{ startAmbientLayer(); showModeSelect(true); });
  }

  /* Layer init after sizeCanvas, which is what first places and sizes it.
     floating-text is a leaf: it is handed the element and the coordinate
     function and imports neither. */
  initFloatingText(document.getElementById('fct-layer'), fctSquareToPixel);
  /* Cleared on resize and orientation change rather than repositioned live: a
     label is a 1.1s transient, so redrawing it in a new geometry is more work
     and more ways to be wrong than simply letting the burst go. */
  window.addEventListener('resize', clearFloatingText);
  window.addEventListener('orientationchange', clearFloatingText);
}

start();

/* An invite link (?join=CODE) opens straight into the online lobby with the
   code filled in, joining at once if this phone already knows its player's
   name. Loaded on demand like the menu button. */
{
  const joinCode = new URLSearchParams(location.search).get('join');
  if(joinCode) import('./online.js').then(m => m.openLobby({ joinCode }));
  const groupCode = new URLSearchParams(location.search).get('group');
  if(groupCode) import('./online-group.js').then(m => m.openGroupLobby({ joinCode: groupCode }));
}

/* Before the board is first sized: it decides how much of the screen the board gets. */
initSafeArea();
initDespatch();
// Match telemetry: time with the app in the background is not playing time.
document.addEventListener('visibilitychange', () => recVisibility(document.hidden));
// ...and finished matches go to the outbox and on to Supabase (telemetry/sender.js).
initTelemetrySender();
// Unit figures: load the sprite-sheet sidecars (render-figures.js).
initFigures();
// Rearranging a complete deployment by drag or tap (deploy-rearrange.js).
initDeployRearrange();
// Match save: it may only save when no unit is mid-animation (match-save.js).
setAnimatingProbe(() => Object.keys(unitAnimations).length > 0);

/* ?fps in the address shows a small frame-rate meter in the corner, for
   checking smoothness on a real phone: frames per second over the last
   second, and the longest gap between frames (a stutter shows as a big one). */
if(new URLSearchParams(location.search).has('fps')){
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:calc(env(safe-area-inset-left,0px) + 70px);bottom:calc(env(safe-area-inset-bottom,0px) + 4px);z-index:99;' +
    'font:12px ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:4px;pointer-events:none';
  document.body.appendChild(el);
  let frames = 0, worst = 0, last = performance.now(), windowStart = last;
  const tick = now => {
    frames++; worst = Math.max(worst, now - last); last = now;
    if(now - windowStart >= 1000){
      el.textContent = `${Math.round(frames * 1000 / (now - windowStart))} fps  worst ${Math.round(worst)} ms`;
      frames = 0; worst = 0; windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
