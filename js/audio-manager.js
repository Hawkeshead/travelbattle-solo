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
import { COLS } from './data-core.js';

export const AudioManager = (function(){
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
    audioCtx: null,
    bufferCache: new Map(),   // url -> Promise<AudioBuffer>, decoded once and reused forever
  };

  function loadPrefs(){
    try {
      const saved = JSON.parse(localStorage.getItem('tb:audioPrefs') || 'null');
      if(saved){
        state.muted = !!saved.muted;
        Object.assign(state.volumes, saved.volumes || {});
      }
    } catch(_e) { /* corrupt/missing prefs — defaults stand */ }
  }
  function savePrefs(){
    try { localStorage.setItem('tb:audioPrefs', JSON.stringify({ muted: state.muted, volumes: state.volumes })); }
    catch(_e) { /* storage unavailable — session-only, not fatal */ }
  }

  // Browsers block audio until a real user gesture. Call this from the
  // first click anywhere (wired in boot.js) — safe to call repeatedly.
  function unlock(){
    if(state.unlocked) return;
    state.unlocked = true;
    if(state.musicEl){ state.musicEl.play().catch(()=>{}); }
    if(state.ambienceEl){ state.ambienceEl.play().catch(()=>{}); }
    getAudioContext().resume().catch(()=>{});
  }

  // Lazily created — some browsers refuse to even construct an AudioContext
  // before a user gesture, so this waits until the first real playEffect/
  // unlock call rather than running at module load.
  function getAudioContext(){
    if(!state.audioCtx){
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
    }
    return state.audioCtx;
  }

  // Decode each effect file exactly once and keep the AudioBuffer in memory —
  // every playEffect() call after that just spins up a fresh, essentially-free
  // AudioBufferSourceNode from the already-decoded data. Without this, every
  // single trigger did a full fetch+decode via `new Audio()`, and under any
  // burst of triggers (several units selected/moved in quick succession,
  // especially during an AI turn) those decodes queued up behind each other
  // and the resulting sounds all landed at once, late, instead of each
  // playing right when its own trigger fired.
  function loadBuffer(url){
    if(state.bufferCache.has(url)) return state.bufferCache.get(url);
    const promise = fetch(url)
      .then(res => res.arrayBuffer())
      .then(bytes => getAudioContext().decodeAudioData(bytes));
    state.bufferCache.set(url, promise);
    return promise;
  }

  // Call as early as convenient (e.g. right after unlock) for any effect
  // likely to be needed soon, so its buffer is already decoded and sitting
  // in memory well before the first real trigger — otherwise that first
  // trigger still pays the one-time fetch+decode cost itself.
  function preloadEffects(urls){
    urls.forEach(loadBuffer);
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
    state.activeEffects.set(key, current+1); // reserve the slot now, not after the (async) decode resolves

    let settled = false;
    const release = ()=>{ if(settled) return; settled = true; state.activeEffects.set(key, Math.max(0,(state.activeEffects.get(key)||1)-1)); };

    loadBuffer(chosen).then(buffer => {
      if(settled) return; // e.g. the safety-net timeout already fired while this was still decoding
      try {
        const ctx = getAudioContext();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = effectiveVolume('effects') * (opts.volumeScale ?? 1);
        source.connect(gain);
        if(opts.pan != null && ctx.createStereoPanner){
          const panner = ctx.createStereoPanner();
          panner.pan.value = opts.pan;
          gain.connect(panner);
          panner.connect(ctx.destination);
        } else {
          gain.connect(ctx.destination);
        }
        source.onended = release;
        /* opts.loop repeats the clip rather than letting it run out. Paired with
           durationMs this covers any length of action from a short sample: the
           gallop is 4s and a three-square cavalry move is 5.04s, so it wraps once
           and is cut at the right moment. The alternative, stretching a sample to
           fit, pitches it down and turns a gallop into a shire horse. */
        if(opts.loop) source.loop = true;
        if(PRIORITY[category] && PRIORITY[category] <= PRIORITY.cavalryCharge) duck();
        source.start();

        /* opts.durationMs stops the sound early, with a short fade so it does
           not click. Marching is the case this exists for: the clip is a
           continuous seven seconds of a column on the move, and it should last
           exactly as long as the unit is walking, whether that is one square or
           three. Playing the whole file would have the sound continuing after
           the unit had stopped.

           Faded rather than cut: stopping a waveform mid-cycle is an audible
           click, and at this volume it would be the loudest thing in the mix. */
        if(opts.durationMs > 0){
          // Required for a looping source: it never reaches its end, so without
          // an explicit stop it would play until the safety net fired 8 seconds
          // later, long after the unit had halted.
          const stopAt = ctx.currentTime + opts.durationMs/1000;
          const fade = Math.min(0.18, opts.durationMs/1000 * 0.25);
          gain.gain.setValueAtTime(gain.gain.value, Math.max(ctx.currentTime, stopAt - fade));
          gain.gain.linearRampToValueAtTime(0.0001, stopAt);
          source.stop(stopAt + 0.02);
        }
      } catch(_e) { release(); }
    }).catch(release);
    // Safety net: if decode stalls or onended never fires for some reason,
    // don't let one stuck reservation silently cap out this key forever.
    setTimeout(release, 8000);
  }

  // Simple left/centre/right stereo positioning based on board x-position (0..COLS).
  // Deliberately coarse — three zones, not a continuous pan — per the "don't over-engineer" brief.
  function panForBoardX(x){
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
    } catch(_e) { /* silent failure */ }
  }
  function stopMusic(){ if(state.musicEl){ try{ state.musicEl.pause(); }catch(_e){} state.musicEl = null; } }

  function playAmbience(src, opts){
    opts = opts || {};
    try {
      if(state.ambienceEl){ state.ambienceEl.pause(); state.ambienceEl = null; }
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = effectiveVolume('ambience');
      state.ambienceEl = audio;
      if(state.unlocked) audio.play().catch(()=>{});
    } catch(_e) { /* silent failure */ }
  }
  function stopAmbience(){ if(state.ambienceEl){ try{ state.ambienceEl.pause(); }catch(_e){} state.ambienceEl = null; } }

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
    setMuted, setVolume, getPrefs, panForBoardX, preloadEffects,
  };
})();
