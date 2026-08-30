import { loadCampaignProgress, resumeCampaignFromStorage } from './campaign.js';
import { sizeCanvas } from './render-board.js';
import { initDesk } from './render-desk.js';
import { initBattleControls, initBoardInput } from './ui-battle.js';
import { OPERATIONS_ENABLED, showModeSelect } from './ui-menus.js';
import { AudioManager } from './audio-manager.js';

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
      'audio/effects/cavalry-select-sword.wav', 'audio/effects/cavalry-gallop.wav',
      'audio/effects/brigadier-select-attention.wav', 'audio/effects/brigadier-gallop.wav',
      'audio/effects/artillery-select.wav', 'audio/effects/artillery-move.wav',
      'audio/effects/artillery-fire.wav', 'audio/effects/artillery-impact.wav',
      'audio/effects/unit-destroyed.wav',
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
  const savedCampaignProgress = OPERATIONS_ENABLED ? loadCampaignProgress() : null;
  if(savedCampaignProgress){
    resumeCampaignFromStorage(savedCampaignProgress);
  } else {
    showModeSelect(true);
  }

  sizeCanvas();
}

start();
