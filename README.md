# TravelBattle: Field Command

A Napoleonic tabletop battle, adapted for the phone.

**▶ Play it here: https://accipiter117.github.io/travelbattle-solo/**

Deploy your brigades across two joined boards, hold the ridge, and see whether
your line survives the cavalry. Play hotseat against a friend, fight the AI, or
work through a campaign of linked engagements.

> An unofficial digital adaptation of the TravelBattle board game, built by
> Matthew Hawkes. Not affiliated with or endorsed by the publisher of the
> original game.

---

## Install it on your phone

**iPhone / iPad** — open the link in Safari, tap Share, then **Add to Home Screen**.

**Android** — open the link in Chrome, tap the ⋮ menu, then **Add to Home screen**.

---

## How to play

| Mode | What it is |
|---|---|
| **Hotseat** | Two players, one device, passed back and forth. |
| **vs AI** | Play a side against the computer, at three difficulties. |
| **Operations** | Standalone historical scenarios with their own objectives. |
| **Campaigns** | Linked engagements with branching choices; progress saves automatically. |
| **Grand Strategy** | A larger 20×20 board with doubled armies. |

Tap a unit to select it, then tap a square to move. The panel shows that
regiment's stats, its history, and what it can do this turn. Form Square against
cavalry. Undo (↺) reverses your last move; the Field Report (☰) shows what has
happened and what the AI was thinking.

---

## Working on the game

You need [Node.js](https://nodejs.org) 22 or later.

To run the game locally:

```bash
npm start
```

That serves it at http://localhost:8080 and opens a browser.

**You must use this command. The game will not work if you double-click
`index.html`.** Browsers refuse to let a page opened as a local file load its
own data files, and the game loads all its content from `data/*.json`. If you
try, you get a red error card explaining exactly that.

Before pushing a change, check nothing is broken:

```bash
npm run check
```

That verifies every image and sound file referenced in the code actually exists,
and that the game data is valid and internally consistent.

### Publishing a change

Commit and push to `main`. GitHub runs the checks and, if they pass, puts the
new version live in about two minutes.

**If the checks fail, the live game does not change.** You get an email and a
red ✗ next to your commit. Everyone else keeps playing the last working version
until you fix it.

### Putting the game back if something goes wrong

1. Go to the [Actions tab](https://github.com/accipiter117/travelbattle-solo/actions)
2. Find the last run with a green ✓ from before the problem
3. Click it, then click **Re-run all jobs** (top right)

That redeploys the older working version. Nothing is lost.

---

## How the code is laid out

| Path | What lives there |
|---|---|
| `index.html` | The page shell and all the styling |
| `js/data-core.js` | Loads `data/*.json`, board geometry, shared constants, game state |
| `js/engine-*.js` | Rules: turn state, movement, combat, objectives |
| `js/ai-*.js` | The computer opponent: deployment, tactics, strategy |
| `js/render-*.js` | Drawing the board and the units |
| `js/ui-*.js` | Menus, the deployment screen, the battle screen |
| `js/audio-*.js` | Sound — currently unplugged, see [AUDIO_SYSTEM.md](AUDIO_SYSTEM.md) |
| `data/*.json` | All game content: units, scenarios, campaigns, narration |
| `assets/` | Portraits and icons |
| `test/` | Data and rules tests (`npm test`) |
| `tools/` | Repository checks used by CI |

**Changing game content — units, scenarios, campaign text — means editing
`data/*.json` only.** No code changes needed.

The scripts in `js/` load in the order listed at the bottom of `index.html`, and
that order matters: each file uses functions defined by the ones above it.

---

## Known issues

See [TRIAGE.md](TRIAGE.md) for the current list of known bugs, ranked by
severity, with the evidence for each.

---

## Licence and credits

Source code: [MIT](LICENSE).

**Artwork and audio are not covered by that licence** — see [ASSETS.md](ASSETS.md)
for the provenance and terms of each file.

Sound effects by [Kenney](https://kenney.nl) (CC0). Full audio credits in
[AUDIO_CREDITS.txt](AUDIO_CREDITS.txt).
