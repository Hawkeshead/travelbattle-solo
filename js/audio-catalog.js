/* =========================================================
   AUDIO CATALOG
   Maps each game event to its sound file(s). Populated as assets are
   sourced — see AUDIO_CREDITS.txt for what's confirmed vs. still
   needed. Everything here is CC0 (Kenney) or will be documented with
   its licence/attribution the moment it's added.
========================================================= */
const AUDIO = {
  music: {
    // battle: null,      // A — main battlefield/deployment music: NOT YET SOURCED (see AUDIO_CREDITS.txt)
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
