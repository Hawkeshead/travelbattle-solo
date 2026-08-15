/* =========================================================
   BOOT
   The single entry point. Everything above this file defines things;
   this file is the only one that *does* anything at start-up.

   Keeping start-up in one explicit function — rather than spread across
   whichever statements happened to sit at the top level of each file —
   means the order is visible here instead of being an emergent property
   of the script order in index.html.
========================================================= */

function start(){
  // Input and control wiring first, so the DOM is fully live before any
  // screen is drawn.
  initBoardInput();
  initBattleControls();

  // Then either resume the campaign in progress or show the title screen.
  const savedCampaignProgress = loadCampaignProgress();
  if(savedCampaignProgress){
    resumeCampaignFromStorage(savedCampaignProgress);
  } else {
    showModeSelect(true);
  }

  sizeCanvas();
}

start();
