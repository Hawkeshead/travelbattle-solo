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
  const liveHandles = new Map();   // effect key -> Set of handles still playing or decoding
  const MAX_CONCURRENT = {
    default: 4,   // cap on simultaneous copies of the same effect, so a busy turn doesn't turn into noise
    /* ONE VOLLEY AT A TIME. Each take is four seconds and opens with an officer
       shouting a line, and overlapping speech is the one thing in this set that
       turns into mush rather than texture. A volley is also a deliberate player
       action taken one at a time, so a second should never be underway while the
       first is still calling fire. */
    'musket-volley': 1,
    /* The death cry is 3.5s and carries. A single fight can destroy two units,
       and a Column break takes both halves at once, so four of these overlapping
       would be a wall of screaming rather than a battle. Two reads as a volley's
       worth of casualties, which is the intent. */
    'unit-destroyed': 2,
  };

  const state = {
    unlocked: false,
    muted: false,
    // Music sits well below the effects on purpose: it is a bed, and at 0.6 it
    // buried the marching, the gallop and the sabres unless everything else was
    // pushed to maximum.
    // Master starts at full: with the curve below, a category slider at 100%
    // should mean full, not 80% of it.
    volumes: { master: 1.0, music: 0.55, effects: 1.0, ambience: 0.75 },
    liveEffectGains: new Set(),   // gain nodes of effects currently sounding; see applyVolumes
    musicSrc: null,               // what the music element is playing, so the same track is not restarted
    musicSequence: null,          // the running multi-track score, if any
    musicSequenceNext: 0,         // which track the NEXT sequence opens on, so battles do not all start alike
    musicEl: null,
    ambienceEl: null,
    activeEffects: new Map(), // key -> count of currently-playing copies
    lastVariant: new Map(),   // key -> index last played, so we don't immediately repeat
    duckTimer: null,
    audioCtx: null,
    bufferCache: new Map(),   // url -> Promise<AudioBuffer>, decoded once and reused forever
  };

  /* Bumped when the meaning of a stored value changes. Slider positions were
     linear gain; they are now positions on a squared curve, so an old 0.85 is a
     different sound from a new 0.85. Reapplying the old numbers under the new
     curve would make everything quieter at once, which is the opposite of what
     the change is for, so a stale set is discarded once and the new defaults
     stand. The mute setting is harmless and carries over. */
  const PREFS_VERSION = 2;

  function loadPrefs(){
    try {
      const saved = JSON.parse(localStorage.getItem('tb:audioPrefs') || 'null');
      if(saved){
        state.muted = !!saved.muted;
        if(saved.version === PREFS_VERSION) Object.assign(state.volumes, saved.volumes || {});
      }
    } catch(_e) { /* corrupt/missing prefs — defaults stand */ }
  }
  function savePrefs(){
    try { localStorage.setItem('tb:audioPrefs',
      JSON.stringify({ version: PREFS_VERSION, muted: state.muted, volumes: state.volumes })); }
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
    wireInterruptionRecovery();
  }

  /* COMING BACK FROM AN INTERRUPTION.

     Leave the app, take a call, or start Spotify, and the OS takes audio focus.
     Come back and the effects work but the score and the ambience are gone for
     the rest of the match. That is not one bug, it is the two halves of this
     manager failing differently:

       EFFECTS are Web Audio. The context gets suspended, but every playEffect
       spins up a fresh source node, and the first one after the interruption
       nudges the context back to running. They recover by accident.

       MUSIC AND AMBIENCE are HTMLAudioElements. iOS PAUSES them and never
       resumes them, because resuming someone's background music without asking
       would be rude. Nothing in here was listening for the moment it became
       reasonable to ask again, so they stayed paused forever.

     Worse for the battle score specifically: it is a sequence that advances on
     each track's 'ended' event. A track paused two minutes in never ends, so
     even once something else woke the element the sequence had no way to move
     on. It is not just silent, it is stuck.

     So: resume the context, and restart whichever elements were meant to be
     playing and are not. state.musicSrc is the record of intent, cleared by
     stopMusic, so a score deliberately stopped is not dragged back to life.

     THREE EVENTS, because no single one is reliable across browsers.
     visibilitychange is the main one and covers backgrounding the app.
     focus covers returning to the tab on desktop without a visibility change.
     The context's own statechange covers the case where audio focus is lost and
     regained while the page never went anywhere, which is what a Spotify track
     starting and stopping in the background looks like.

     All three land in the same idempotent function, so firing two or three times
     over costs a pair of no-op play() calls on elements already playing.

     Mute is not checked here on purpose: muting sets the volume to zero and
     leaves the elements running, so a muted score still has to be playing or it
     will not be there when the volume comes back up. */
  let recoveryWired = false;
  function resumeAfterInterruption(){
    if(!state.unlocked) return;
    try { getAudioContext().resume().catch(()=>{}); } catch(_e) { /* no context yet */ }
    if(state.musicEl && state.musicSrc && state.musicEl.paused){
      state.musicEl.play().catch(()=>{
        /* The element can come back unusable rather than merely paused. If a
           score is running, rebuilding the current track from scratch is the
           way back; playMusic makes a new element and the sequence re-attaches
           its 'ended' listener to it. */
        const seq = state.musicSequence;
        if(seq){ state.musicSequence = null; playMusicSequence(seq.srcs); }
      });
    }
    if(state.ambienceEl && state.ambienceEl.paused){ state.ambienceEl.play().catch(()=>{}); }
  }
  function wireInterruptionRecovery(){
    if(recoveryWired) return;
    recoveryWired = true;
    try {
      document.addEventListener('visibilitychange', ()=>{
        if(!document.hidden) resumeAfterInterruption();
      });
      window.addEventListener('focus', resumeAfterInterruption);
      const ctx = getAudioContext();
      if(ctx && typeof ctx.addEventListener === 'function'){
        ctx.addEventListener('statechange', ()=>{
          if(ctx.state === 'running') resumeAfterInterruption();
        });
      }
    } catch(_e) { /* no DOM or no context: nothing to recover to */ }
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

  /* Perceptual curve on the sliders.

     Gain is linear, hearing is not. On a straight mapping, half the slider's
     travel is spent inside the top 6dB: 75% is barely quieter than 100% and 50%
     only just noticeable, so the control feels dead until the bottom third.
     Squaring spreads it out, so 50% lands at -12dB and reads as genuinely half.

     Applied to master and the category separately, so each behaves the same way
     rather than the pair compounding into something steeper. */
  const SLIDER_CURVE = 2;
  function curve(v){ return Math.pow(Math.max(0, Math.min(1, v)), SLIDER_CURVE); }

  function effectiveVolume(category){
    if(state.muted) return 0;
    return curve(state.volumes.master) * curve(state.volumes[category] ?? 1);
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

    /* A HANDLE ON THIS ONE PLAY, so it can be faded out early. It fades only
       its own gain node: every play gets a fresh node at full level, so fading
       one out can never leave the next one quiet or muted. Faded before it has
       even started (still decoding), it simply never starts. */
    const handle = { key, cancelled: false, done: false, source: null, gain: null, liveGain: null,
      fadeOut(ms){
        if(handle.done) return;
        handle.cancelled = true;
        if(!handle.source) return;
        handle.done = true;
        // Out of the live set first, or a volume-slider move mid-fade would
        // snap it back to full.
        state.liveEffectGains.delete(handle.liveGain);
        try {
          const ctx = getAudioContext(), now = ctx.currentTime, end = now + Math.max(0.05, ms/1000);
          const g = handle.gain.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(0.0001, end);
          handle.source.stop(end + 0.02);
        } catch(_e) { /* already stopped */ }
      } };
    if(!liveHandles.has(key)) liveHandles.set(key, new Set());
    liveHandles.get(key).add(handle);

    let settled = false;
    const release = ()=>{ if(settled) return; settled = true; state.activeEffects.set(key, Math.max(0,(state.activeEffects.get(key)||1)-1)); };
    const forget = ()=>{ handle.done = true; const set = liveHandles.get(key); if(set) set.delete(handle); };

    loadBuffer(chosen).then(buffer => {
      if(settled) return; // e.g. the safety-net timeout already fired while this was still decoding
      try {
        const ctx = getAudioContext();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = effectiveVolume('effects') * (opts.volumeScale ?? 1);
        const liveGain = { node: gain, scale: (opts.volumeScale ?? 1) };
        if(handle.cancelled){ forget(); release(); return; }   // faded out while still decoding
        handle.source = source; handle.gain = gain; handle.liveGain = liveGain;
        state.liveEffectGains.add(liveGain);
        source.connect(gain);
        if(opts.pan != null && ctx.createStereoPanner){
          const panner = ctx.createStereoPanner();
          panner.pan.value = opts.pan;
          gain.connect(panner);
          panner.connect(ctx.destination);
        } else {
          gain.connect(ctx.destination);
        }
        source.onended = ()=>{ state.liveEffectGains.delete(liveGain); forget(); release(); };
        /* opts.loop repeats the clip rather than letting it run out. Paired with
           durationMs this covers any length of action from a short sample: the
           gallop is 4s and a three-square cavalry move is 5.04s, so it wraps once
           and is cut at the right moment. The alternative, stretching a sample to
           fit, pitches it down and turns a gallop into a shire horse. */
        if(opts.loop) source.loop = true;
        if(PRIORITY[category] && PRIORITY[category] <= PRIORITY.cavalryCharge) duck();
        /* opts.delayMs starts the sound a little later than now, on the audio
           clock. Used so an AI unit's march begins after its answering call,
           in step with its animation, which is held back by the same amount. */
        const startAt = ctx.currentTime + Math.max(0, (opts.delayMs || 0) / 1000);
        source.start(startAt);

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
          const stopAt = startAt + opts.durationMs/1000;
          const fade = Math.min(0.18, opts.durationMs/1000 * 0.25);
          gain.gain.setValueAtTime(gain.gain.value, Math.max(startAt, stopAt - fade));
          gain.gain.linearRampToValueAtTime(0.0001, stopAt);
          source.stop(stopAt + 0.02);
        }
      } catch(_e) { release(); }
    }).catch(()=>{ forget(); release(); });
    // Safety net: if decode stalls or onended never fires for some reason,
    // don't let one stuck reservation silently cap out this key forever.
    setTimeout(release, 8000);
    return handle;
  }

  /* Fade out every playing effect whose key starts with prefix. Used for the
     turn themes: a turn that ends before its theme does fades it rather than
     letting it run into the next side's turn. */
  function fadeOutEffects(prefix, ms){
    for(const [k, set] of liveHandles){
      if(!k.startsWith(prefix)) continue;
      for(const h of [...set]) h.fadeOut(ms);
    }
  }

  // Simple left/centre/right stereo positioning based on board x-position (0..COLS).
  // Deliberately coarse — three zones, not a continuous pan — per the "don't over-engineer" brief.
  function panForBoardX(x){
    const third = COLS/3;
    if(x < third) return -0.5;
    if(x > COLS-third) return 0.5;
    return 0;
  }

  /* playMusic is called more than once for the same track (menu, then battle).
     The old version paused the existing element and dropped the reference. That
     leaks: pause() on an element whose play() promise is still pending does not
     stick, the element resumes, and it is no longer tracked by anything. The
     result is a second copy of the score playing at whatever volume it was
     created with, deaf to the slider forever after, which is exactly the
     reported symptom.

     Two guards. Playing the SAME track again is now a no-op beyond refreshing
     the volume, so the common case never creates a second element at all. And
     teardown is real: pause, clear the source, and load(), which cancels any
     pending play rather than letting it resume behind us. */
  function stopMusicEl(){
    const el = state.musicEl;
    state.musicEl = null;
    if(!el) return;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch(_e) { /* already gone */ }
  }

  function playMusic(src, opts){
    opts = opts || {};
    try {
      if(state.musicEl && state.musicSrc === src){
        state.musicEl.volume = effectiveVolume('music');   // already playing; just re-level it
        if(state.unlocked && state.musicEl.paused) state.musicEl.play().catch(()=>{});
        return;
      }
      stopMusicEl();
      /* A plain playMusic call outside a sequence ends the sequence, so going
         back to the menu mid-battle does not leave a track queued to barge in. */
      if(opts.loop !== false && state.musicSequence) state.musicSequence = null;
      const audio = new Audio(src);
      audio.loop = opts.loop !== false;
      audio.volume = effectiveVolume('music');
      state.musicEl = audio;
      state.musicSrc = src;
      if(state.unlocked) audio.play().catch(()=>{});
    } catch(_e) { /* silent failure */ }
  }
  function stopMusic(){ stopMusicEl(); state.musicSequence = null; state.musicSrc = null; }

  /* A SCORE OF SEVERAL TRACKS, PLAYED IN TURN.

     playMusic loops one file forever, which is right for the menu and wrong for
     a battle score: a three-minute piece on repeat for a forty-turn match is
     noticeable in a way the piece itself is not. This plays the tracks in order,
     each once, and moves to the next when it ends, cycling for as long as the
     battle lasts.

     WHICH TRACK OPENS ROTATES between calls, so starting a second battle does
     not open with the same bars as the first. It is deliberately not random:
     random would repeat the same opener often enough to be noticed, and with two
     tracks alternating is what was asked for.

     Reuses playMusic's element handling rather than managing its own, so the
     volume slider, the mute toggle and the ducking in applyVolumes all keep
     working without knowing a sequence exists. The double-play bug that
     stopMusicEl guards against would be easy to reintroduce here, which is why
     advancing goes back through playMusic rather than touching the element. */
  function playMusicSequence(srcs){
    if(!srcs || !srcs.length) return;
    if(srcs.length === 1) return playMusic(srcs[0]);
    /* Already running this exact sequence: leave it alone. Restarting on every
       call would cut the score off whenever a menu function re-ran. */
    if(state.musicSequence && state.musicSequence.key === srcs.join('|')) return;
    const start = state.musicSequenceNext || 0;
    state.musicSequenceNext = (start + 1) % srcs.length;
    const seq = { key: srcs.join('|'), srcs, i: start };
    state.musicSequence = seq;
    const advance = () => {
      if(state.musicSequence !== seq) return;   // a different score took over
      seq.i = (seq.i + 1) % seq.srcs.length;
      step();
    };
    const step = () => {
      playMusic(seq.srcs[seq.i], { loop: false });
      if(state.musicEl) state.musicEl.addEventListener('ended', advance, { once: true });
    };
    step();
  }

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
  /* NAMED LOOPS: a sound with a start and a stop rather than a fixed length.

     playEffect can loop, but only for a duration decided up front. The battle
     bed has to last exactly as long as a dice panel is open, which nobody can
     know in advance: a re-roll keeps it open longer, and the panel can be closed
     from three different places. So this is keyed and stopped explicitly.

     Stopping fades over a few tens of milliseconds rather than cutting, because
     a hard stop on a busy loop is an audible click. */
  const namedLoops = new Map();

  function startLoop(key, src, category){
    if(namedLoops.has(key)) return;   // already running; starting again would layer it
    try {
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = effectiveVolume(category);
      namedLoops.set(key, { el: audio, category });
      if(state.unlocked) audio.play().catch(()=>{});
    } catch(_e) { /* silent failure, as elsewhere */ }
  }

  function stopLoop(key, fadeMs){
    const entry = namedLoops.get(key);
    if(!entry) return;
    namedLoops.delete(key);
    const el = entry.el;
    const steps = 6, ms = Math.max(0, fadeMs ?? 180) / steps;
    let n = steps;
    const from = el.volume;
    const tick = ()=>{
      n -= 1;
      if(n <= 0){ try{ el.pause(); el.removeAttribute('src'); el.load(); }catch(_e){} return; }
      try { el.volume = from * (n/steps); } catch(_e) { /* detached */ }
      setTimeout(tick, ms);
    };
    setTimeout(tick, ms);
  }

  function applyVolumes(){
    if(state.musicEl) state.musicEl.volume = effectiveVolume('music');
    if(state.ambienceEl) state.ambienceEl.volume = effectiveVolume('ambience');
    /* Effects run through Web Audio rather than an <audio> element, and each one
       reads its gain once at the moment it starts. Without this, dragging the
       effects slider (or muting) left anything already playing at its old
       level, which for a looping five-second gallop is long enough to look
       broken. Live gains are tracked so they can be updated in place. */
    // Named loops track their category too, so a slider move reaches them.
    for(const [, entry] of namedLoops) { try { entry.el.volume = effectiveVolume(entry.category); } catch(_e) { /* detached */ } }
    for(const g of state.liveEffectGains){
      try { g.node.gain.value = effectiveVolume('effects') * g.scale; } catch(_e) { /* node already gone */ }
    }
  }
  function getPrefs(){ return { muted: state.muted, volumes: {...state.volumes} }; }
  function resumeAudio(){ resumeAfterInterruption(); }

  loadPrefs();

  return {
    unlock, playEffect, fadeOutEffects, playMusic, playMusicSequence, stopMusic, playAmbience, stopAmbience,
    setMuted, setVolume, getPrefs, resumeAudio, panForBoardX, preloadEffects,
    startLoop, stopLoop,
    /* Read-only handles for audio-lab.html. The lab compares what the mixer
       THINKS a stream's volume should be against what the element is really
       playing at; without these it can only see the first half, which is the
       half that already looks correct. Deliberately getters rather than the
       elements themselves, so nothing outside can reassign them. */
    debugMusicElement: ()=> state.musicEl,
    debugAmbienceElement: ()=> state.ambienceEl,
  };
})();
