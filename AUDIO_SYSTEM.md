# Audio System

## Files

- `js/audio-manager.js` — the generic, reusable engine. Music/ambience playback, per-category volume, mute, random-variation selection (no immediate repeats), a simple priority/ducking system, coarse stereo positioning, and settings persistence (localStorage). Nothing in here references specific game events or DOM outside the settings panel.
- `js/audio-catalog.js` — the `AUDIO` object: maps each event key to its file path(s). This is the file to edit when adding or swapping a sound — no code changes needed elsewhere.
- `js/audio-hooks.js` — the only file that connects real game events (button clicks, phase changes, combat results, etc.) to `AudioManager` calls. Keeps every other game file free of scattered audio logic, per the original brief's instruction.

## Adding or replacing a sound

1. Add the audio file under `audio/<category>/`.
2. Add its path to the matching entry in `js/audio-catalog.js`. Use an array if you want random variation between multiple takes of the same sound (footsteps, musket fire, etc.) — `AudioManager` automatically avoids repeating the same one twice in a row.
3. If it's a brand new event (not yet hooked up), add the trigger in `js/audio-hooks.js`, calling one of:
   - `AudioManager.playEffect(key, files, category, opts)` — one-shot sound effect. `key` identifies it for the repeat-avoidance and concurrency cap; `category` sets its priority/ducking/volume bucket (`ui`, `movement`, `musketVolley`, `cavalryCharge`, `majorCombat`, `cannon`, `ambient`).
   - `AudioManager.playMusic(src, opts)` / `stopMusic()`
   - `AudioManager.playAmbience(src, opts)` / `stopAmbience()`
4. Document the source/licence/attribution in `AUDIO_CREDITS.txt`.

## Volume defaults

Master 0.8, Music 0.6, Effects 0.85, Ambience 0.5 — all adjustable in-game via the audio settings panel (the note icon next to Undo/Field Report), persisted across sessions.

## Autoplay handling

Browsers block audio until a genuine user gesture. `audio-hooks.js` listens for the very first `pointerdown` anywhere on the page and calls `AudioManager.unlock()` once — this covers every entry path into the game (Hotseat, vs AI, Grand Strategy, Campaigns) rather than hardcoding a single "Begin" button. If audio fails to unlock or a file fails to load, every `AudioManager` call is wrapped so it fails silently — gameplay is never blocked by an audio problem.

## Current status

UI click/switch sounds (Phase 1, requirement F) are live, using Kenney's CC0 UI Audio Pack. Everything else — music, ambience, dice, and all of Phase 2's unit-specific sounds — is scaffolded (the catalog has commented-out slots, the priority/ducking system already accounts for cannon/combat/cavalry categories) but not yet populated, pending asset sourcing. See `AUDIO_CREDITS.txt` for exactly what's outstanding and why.
