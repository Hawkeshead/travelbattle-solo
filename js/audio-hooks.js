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

// F — button/select sound. A single delegated listener rather than editing
// every button handler individually (dozens across ui-menus/ui-battle/
// ui-deployment/campaign) — matches "don't scatter audio logic" from the brief.
// Excludes the dice roll button (gets its own distinct sound once G is sourced)
// and roster chips (their own drag interaction, not a simple click).
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button');
  if(!btn) return;
  if(btn.id === 'diceRollBtn') return; // reserved for G once sourced
  if(btn.classList.contains('roster-chip')) return;
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
