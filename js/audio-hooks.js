/* =========================================================
   AUDIO HOOKS
   The only file that connects real game events to AudioManager —
   keeps audio-manager.js itself generic/reusable, and keeps every
   other game file free of scattered audio calls. Add new hooks here
   as Phase 2/3 assets come in (see AUDIO_SYSTEM.md).
========================================================= */

// Unlock audio on the very first user gesture anywhere, satisfying every
// browser's autoplay policy regardless of which button starts the game.
document.addEventListener('pointerdown', ()=> AudioManager.unlock(), { once:true });

// F — button/select sound, covering every real way a player clicks something:
// actual <button> elements (menus, End Move/Fire/Fight, Undo...), the board
// itself (selecting a unit, moving, choosing a target, placing during
// deployment), and the couple of interactive elements built as <div>s rather
// than <button>s (roster chips, the unit-history toggle). A single delegated
// listener rather than editing dozens of handlers individually, per "don't
// scatter audio logic" — but it has to check all three shapes, since the
// original button-only version missed the board entirely, which is most of
// what a player actually clicks during a real game.
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  const isBoard = e.target && e.target.id === 'board';
  const isChipLike = e.target.closest('.roster-chip') || e.target.closest('#bioToggleBtn');
  if(!btn && !isBoard && !isChipLike) return;
  if(btn && btn.id === 'diceRollBtn') return; // reserved for G once sourced
  AudioManager.playEffect('ui-click', AUDIO.ui.click, 'ui');
});

// Settings panel — mute + four volume sliders, persisted via AudioManager/localStorage.
(function initAudioSettingsPanel(){
  const panel = document.getElementById('audioSettingsPanel');
  const openBtn = document.getElementById('audioSettingsBtn');
  const closeBtn = document.getElementById('audioSettingsCloseBtn');
  const backdrop = document.getElementById('audioSettingsBackdrop');
  const muteToggle = document.getElementById('audioMuteToggle');
  const sliders = {
    master: document.getElementById('audioVolMaster'),
    music: document.getElementById('audioVolMusic'),
    effects: document.getElementById('audioVolEffects'),
    ambience: document.getElementById('audioVolAmbience'),
  };
  if(!panel || !openBtn) return; // defensive — never break boot if markup is missing

  function syncFromPrefs(){
    const prefs = AudioManager.getPrefs();
    muteToggle.checked = prefs.muted;
    Object.keys(sliders).forEach(cat => { if(sliders[cat]) sliders[cat].value = prefs.volumes[cat]; });
  }
  openBtn.onclick = ()=>{ syncFromPrefs(); panel.classList.remove('hidden'); };
  closeBtn.onclick = ()=> panel.classList.add('hidden');
  backdrop.onclick = ()=> panel.classList.add('hidden');
  muteToggle.onchange = ()=> AudioManager.setMuted(muteToggle.checked);
  Object.keys(sliders).forEach(cat => {
    if(!sliders[cat]) return;
    sliders[cat].oninput = ()=> AudioManager.setVolume(cat, parseFloat(sliders[cat].value));
  });
  syncFromPrefs();
})();
