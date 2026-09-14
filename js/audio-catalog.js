/* =========================================================
   AUDIO CATALOG

   NOT LOADED BY ANYTHING. Nothing imports this file. Every sound that actually
   plays is called directly by name from the game code (AudioManager.playEffect
   in ai-strategy, render-board and ui-battle; playMusic in boot and ui-menus).
   Kept because the mapping is still the right idea and the sound effects should
   come back through it, but do not add a sound here and expect to hear it.
   Maps each game event to its sound file(s). Populated as assets are
   sourced — see AUDIO_CREDITS.txt for what's confirmed vs. still
   needed. Everything here is CC0 (Kenney) or will be documented with
   its licence/attribution the moment it's added.
========================================================= */
const AUDIO = {
  music: {
    /* A — battlefield/deployment music: SOURCED. Not listed here because it is a
       SEQUENCE of two tracks rather than a single file, and this catalogue maps
       one event to one sound. It lives in ui-menus as BATTLE_SCORE and is played
       through AudioManager.playMusicSequence. Noted rather than left blank so
       the next person does not source it again. */
    // victory: null,     // B — victory fanfare: NOT YET SOURCED
    // defeat: null,      // C — defeat cue: NOT YET SOURCED
  },
  ambience: {
    // battlefield: null, // D — general battlefield ambience: NOT YET SOURCED
    // distant: null,     // E — distant battle: NOT YET SOURCED
  },
  ui: {
    // F — button/select: Kenney UI Audio (CC0) — see AUDIO_CREDITS.txt
    click: ['audio/ui/click1.wav', 'audio/ui/click4.wav'],
    switch: ['audio/ui/switch12.wav', 'audio/ui/switch14.wav'],
    // G — dice roll: NOT YET SOURCED
    // H — phase/end-turn signal: NOT YET SOURCED
  },
};
