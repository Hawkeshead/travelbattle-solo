/* =========================================================
   AUDIO MANAGER
   Central home for every sound in the game — nothing plays audio
   directly anywhere else. Handles music, ambience, one-shot effects,
   per-category volume, mute, random-variation selection (no immediate
   repeats), priority/ducking, and settings persistence.

   Asset paths point at /audio/<category>/<name>.wav|mp3 — see
   AUDIO_CREDITS.txt for source/licence per file, and AUDIO_SYSTEM.md
   for how to add or replace sounds. A missing/unloadable file never
   breaks gameplay: every play call is wrapped so a failure just means
   silence, not a crashed game.
========================================================= */
const AudioManager = (function(){
  const PRIORITY = { cannon:1, majorCombat:2, cavalryCharge:3, musketVolley:4, movement:5, ui:6, ambient:7 };
  const MAX_CONCURRENT = { default: 4 }; // cap on simultaneous copies of the same effect, so a busy turn doesn't turn into noise

  const state = {
    unlocked: false,
    muted: false,
    volumes: { master: 0.8, music: 0.6, effects: 0.85, ambience: 0.5 },
    musicEl: null,
    ambienceEl: null,
    activeEffects: new Map(), // key -> count of currently-playing copies
    lastVariant: new Map(),   // key -> index last played, so we don't immediately repeat
    duckTimer: null,
  };

  function loadPrefs(){
    try {
      const saved = JSON.parse(localStorage.getItem('tb:audioPrefs') || 'null');
      if(saved){
        state.muted = !!saved.muted;
        Object.assign(state.volumes, saved.volumes || {});
      }
    } catch(e) { /* corrupt/missing prefs — defaults stand */ }
  }
  function savePrefs(){
    try { localStorage.setItem('tb:audioPrefs', JSON.stringify({ muted: state.muted, volumes: state.volumes })); }
    catch(e) { /* storage unavailable — session-only, not fatal */ }
  }

  // Browsers block audio until a real user gesture. Call this from the
  // first click anywhere (wired in boot.js) — safe to call repeatedly.
  function unlock(){
    if(state.unlocked) return;
    state.unlocked = true;
    if(state.musicEl){ state.musicEl.play().catch(()=>{}); }
    if(state.ambienceEl){ state.ambienceEl.play().catch(()=>{}); }
  }

  function effectiveVolume(category){
    if(state.muted) return 0;
    return state.volumes.master * (state.volumes[category] ?? 1);
  }

  // Picks a random file from a category's variant list, avoiding an
  // immediate repeat of whatever played last time for that same key.
  function pickVariant(key, files){
    if(!files || !files.length) return null;
    if(files.length === 1) return files[0];
    let idx;
    const last = state.lastVariant.get(key);
    do { idx = Math.floor(Math.random()*files.length); } while(idx === last && files.length > 1);
    state.lastVariant.set(key, idx);
    return files[idx];
  }

  function duck(){
    if(!state.musicEl && !state.ambienceEl) return;
    clearTimeout(state.duckTimer);
    const targets = [state.musicEl, state.ambienceEl].filter(Boolean);
    targets.forEach(el => el.volume = Math.min(el.volume, effectiveVolume(el===state.musicEl?'music':'ambience') * 0.35));
    state.duckTimer = setTimeout(()=>{
      if(state.musicEl) state.musicEl.volume = effectiveVolume('music');
      if(state.ambienceEl) state.ambienceEl.volume = effectiveVolume('ambience');
    }, 900);
  }

  // category: 'ui' | 'movement' | 'musketVolley' | 'cavalryCharge' | 'majorCombat' | 'cannon' | 'ambient'
  // files: array of paths to choose a random variant from (or a single path)
  function playEffect(key, files, category, opts){
    opts = opts || {};
    if(!state.unlocked) return;
    const list = Array.isArray(files) ? files : [files];
    const chosen = pickVariant(key, list);
    if(!chosen) return;

    const cap = MAX_CONCURRENT[key] || MAX_CONCURRENT.default;
    const current = state.activeEffects.get(key) || 0;
    if(current >= cap) return; // already plenty of this sound playing — drop it rather than pile on

    try {
      const audio = new Audio(chosen);
      audio.volume = effectiveVolume('effects') * (opts.volumeScale ?? 1);
      if(opts.pan && audio.pan !== undefined) audio.pan = opts.pan; // simple stereo positioning, see setPositional()
      state.activeEffects.set(key, current+1);
      let settled = false;
      const release = ()=>{ if(settled) return; settled = true; state.activeEffects.set(key, Math.max(0,(state.activeEffects.get(key)||1)-1)); };
      audio.addEventListener('ended', release);
      audio.addEventListener('error', release);
      // Safety net: on a slow/flaky real connection, 'ended'/'error' aren't
      // guaranteed to fire promptly for every browser/file — without this,
      // one stuck count silently caps out at MAX_CONCURRENT and the sound
      // just stops playing entirely with no visible error.
      setTimeout(release, 8000);
      if(PRIORITY[category] && PRIORITY[category] <= PRIORITY.cavalryCharge) duck();
      audio.play().catch(release);
    } catch(e) { /* never let an audio failure break the game */ }
  }

  // Simple left/centre/right stereo positioning based on board x-position (0..COLS).
  // Deliberately coarse — three zones, not a continuous pan — per the "don't over-engineer" brief.
  function panForBoardX(x){
    if(typeof COLS === 'undefined') return 0;
    const third = COLS/3;
    if(x < third) return -0.5;
    if(x > COLS-third) return 0.5;
    return 0;
  }

  function playMusic(src, opts){
    opts = opts || {};
    try {
      if(state.musicEl){ state.musicEl.pause(); state.musicEl = null; }
      const audio = new Audio(src);
      audio.loop = opts.loop !== false;
      audio.volume = effectiveVolume('music');
      state.musicEl = audio;
      if(state.unlocked) audio.play().catch(()=>{});
    } catch(e) { /* silent failure */ }
  }
  function stopMusic(){ if(state.musicEl){ try{ state.musicEl.pause(); }catch(e){} state.musicEl = null; } }

  function playAmbience(src, opts){
    opts = opts || {};
    try {
      if(state.ambienceEl){ state.ambienceEl.pause(); state.ambienceEl = null; }
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = effectiveVolume('ambience');
      state.ambienceEl = audio;
      if(state.unlocked) audio.play().catch(()=>{});
    } catch(e) { /* silent failure */ }
  }
  function stopAmbience(){ if(state.ambienceEl){ try{ state.ambienceEl.pause(); }catch(e){} state.ambienceEl = null; } }

  function setMuted(m){ state.muted = m; applyVolumes(); savePrefs(); }
  function setVolume(category, v){ state.volumes[category] = Math.max(0, Math.min(1, v)); applyVolumes(); savePrefs(); }
  function applyVolumes(){
    if(state.musicEl) state.musicEl.volume = effectiveVolume('music');
    if(state.ambienceEl) state.ambienceEl.volume = effectiveVolume('ambience');
  }
  function getPrefs(){ return { muted: state.muted, volumes: {...state.volumes} }; }

  loadPrefs();

  return {
    unlock, playEffect, playMusic, stopMusic, playAmbience, stopAmbience,
    setMuted, setVolume, getPrefs, panForBoardX,
  };
})();
