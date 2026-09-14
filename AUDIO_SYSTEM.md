# Audio System

> **Status: partly connected, and this file was out of date.** The ENGINE
> (`js/audio-manager.js`) is a module, is imported by `js/boot.js`, and is
> playing: menu music, the battle score, movement and combat effects all run
> through direct `AudioManager` calls from `boot.js`, `ui-menus.js`,
> `ai-strategy.js`, `render-board.js` and `ui-battle.js`.
>
> What is still unplugged is the other two files. Nothing imports
> `js/audio-catalog.js` or `js/audio-hooks.js`, and `index.html` still has no
> settings button or panel. So: sounds play, but the catalogue is decorative and
> THERE IS NO MUTE OR VOLUME CONTROL IN THE GAME AT ALL. That is the real state
> of the "mute toggle does nothing" bug on the backlog — the control is not
> missing a connection, it is missing.

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

Master 0.8, Music 0.6, Effects 0.85, Ambience 0.5 — persisted across sessions in localStorage under `tb:audioPrefs`.

These were adjustable in-game through an audio settings panel reached by a note icon next to Undo/Field Report. That button and panel were removed in `9ea94c2` along with the rest of the audio wiring, so there is currently no way to change them from inside the game. Putting the panel back is step 3 of reconnecting (see "Current status").

## Autoplay handling

Browsers block audio until a genuine user gesture. `audio-hooks.js` listens for the very first `pointerdown` anywhere on the page and calls `AudioManager.unlock()` once — this covers every entry path into the game (Hotseat, vs AI, Grand Strategy, Campaigns) rather than hardcoding a single "Begin" button. If audio fails to unlock or a file fails to load, every `AudioManager` call is wrapped so it fails silently — gameplay is never blocked by an audio problem.

## Current status — engine on, controls off

The engine was reconnected after `9ea94c2` and this section was never updated, which is worth knowing because it said the opposite for several commits: adding a sound WILL make a sound, as long as it is called directly rather than added to the catalogue.

Still outstanding: `audio-catalog.js` and `audio-hooks.js` are not imported by anything, and `index.html` has no settings button or panel, so there is no mute and no volume control.

The work that was done still stands. UI click/switch sounds (Phase 1, requirement F) are sourced and committed, using Kenney's CC0 UI Audio Pack. Everything else — music, ambience, dice, and all of Phase 2's unit-specific sounds — is scaffolded (the catalog has commented-out slots, the priority/ducking system already accounts for cannon/combat/cavalry categories) but not yet populated. See `AUDIO_CREDITS.txt` for what's outstanding.

### Reconnecting it

The rest of `js/` was converted to ES modules; these three files were deliberately left alone. So reconnecting means three things, in order:

1. Convert `audio-catalog.js` and `audio-hooks.js` to modules like the rest of `js/` — add `export` to what they define, `import` what they use, and move their top-level `addEventListener` calls into an init function. `audio-manager.js` is already done.
2. Call that init function from `js/boot.js`, alongside `initBoardInput()` and `initBattleControls()`.
3. Put the settings button and panel back in `index.html`. This is the piece that makes mute and volume exist.
4. Move the direct `playEffect`/`playMusic` calls now scattered through `ai-strategy.js`, `render-board.js`, `ui-battle.js`, `boot.js` and `ui-menus.js` into the hooks, which is where the original brief wanted them.

Worth fixing the original complaint at the same time: the mute and volume controls not reaching playback is what caused the system to be pulled in the first place.
