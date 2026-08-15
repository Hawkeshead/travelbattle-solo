# TravelBattle: Field Command

A Napoleonic tabletop battle, adapted for the phone.

**▶ Play it here: https://hawkeshead.github.io/travelbattle-solo/**

Deploy your brigades across two joined boards, hold the ridge, and see whether
your line survives the cavalry. Play hotseat against a friend, fight the AI, or
work through a campaign of linked engagements.

> A personal digital version of the TravelBattle board game, made by Matthew
> Hawkes for himself and a few friends. Unofficial, and nothing to do with the
> people who make the real game.

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

> Some Operations can't currently be deployed — see C1 in [TRIAGE.md](TRIAGE.md).
> Hotseat, vs AI and Grand Strategy are unaffected.

Tap a unit to select it, then tap a square to move. The panel shows that
regiment's stats, its history, and what it can do this turn. Form Square against
cavalry. Undo (↺) reverses your last move; the Field Report (☰) shows what has
happened and what the AI was thinking.

---

## The rules

The rules here are the base
[TravelBattle](https://boardgamegeek.com/boardgame/228509/travelbattle) rules
merged with its advanced rule set — deliberately, because the base game on its
own plays too easily. **Where the game does something the base rulebook doesn't,
that is intended, not a mistake.**

**The canonical rules reference is the companion app,
[TravelBattle Hub](https://github.com/accipiter117/travelbattle-hub).** If the
code and the Hub disagree, the Hub is right and the code is the bug. If this
README and the Hub disagree, the Hub is right. Don't reason from the printed
rulebook alone.

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

That does four things: confirms every image and sound file referenced in the
code actually exists, confirms no file writes to a value another file owns,
checks for references to names that don't exist, and runs the game-data tests.

There's also `npm run smoke`, which boots the real game in a headless browser
and plays through the opening. It's slower, and CI runs it for you on every push.

One caveat worth knowing: `npm run check` passing does **not** mean the game is
bug-free. It means nothing has got *worse*. The known bugs in
[TRIAGE.md](TRIAGE.md) are recorded in the tests as known, so they don't fail
the build.

### Publishing a change

Commit and push to `main`. GitHub runs the checks and, if they pass, puts the
new version live in a few minutes.

**If the checks fail, the live game does not change.** You get an email and a
red ✗ next to your commit. Everyone else keeps playing the last working version
until you fix it.

> **One-time setup, required before any of that works:** in
> [Settings → Pages](https://github.com/Hawkeshead/travelbattle-solo/settings/pages),
> **Source** must be set to **GitHub Actions** rather than to a branch. Until it
> is, the deploy step fails and nothing reaches the live site. It needs an
> organisation admin, and only has to be done once.

### Putting the game back if something goes wrong

1. Go to the [Actions tab](https://github.com/Hawkeshead/travelbattle-solo/actions)
2. Find the last run with a green ✓ from before the problem
3. Click it, then click **Re-run all jobs** (top right)

That redeploys the older working version. Nothing is lost.

Two things to know. GitHub only offers "Re-run all jobs" on runs from roughly
the last month, so this fixes a problem you spot soon, not a time machine. And
re-running replays that commit's full checks — so if you're rolling back in a
hurry, pick a run you know was green.

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
| `test/` | Game-data tests — run by `npm test` |
| `tests/` | Browser smoke test, which actually plays the game — run by `npm run smoke` |
| `tools/` | Repository checks used by CI |
| `.github/workflows/ci.yml` | What GitHub runs on every push |

**Changing game content — units, scenarios, campaign text — means editing
`data/*.json` only.** No code changes needed.

### How the files find each other

`index.html` loads exactly one script file, `js/boot.js`. (There's also a short
inline script near the top that only fires if you've opened the file directly
instead of serving it — that's the red error card.) Every other file is pulled
in by an `import` line at the top of whichever file needs it, so each file
states its own dependencies and the browser works out the loading order.

That means **you can no longer break the game by putting things in the wrong
order** — which used to be possible, because `index.html` carried a
hand-maintained list of sixteen script tags that had to stay in exactly the
right sequence.

When you add a function to one file and want to use it in another:

1. Put `export` in front of it — `export function myThing(){ ... }`
2. At the top of the file that needs it, add
   `import { myThing } from './that-file.js';`

Two rules worth knowing, because breaking them fails in confusing ways:

- **You cannot assign to something you imported.** `import { CELL }` then
  `CELL = 40` throws an error. If another file needs to change a value, that
  file's owner exports a small function to do it — see `setCell()` in
  `data-core.js` for the pattern. `npm run check` enforces this.
- **Anything called from an `onclick="..."` attribute in HTML must also be put
  on `window`,** because inline handlers can't see module scope. There is one
  of these, `toggleUnitBio`, and it's commented in `js/ui-battle.js`.

Most start-up work happens in `js/boot.js`, which is the one file that exists to
*do* something rather than define things. A few files still register their own
listeners as they load — `render-board.js` attaches the canvas pan/zoom
handlers, `replay.js` wires its exit button — which is fine, but if you're
tracing what happens on load, start at `boot.js` and remember those two.

The three `js/audio-*.js` files are not part of this — they were unplugged from
the game and are left exactly as they were, ready to be reconnected.

---

## Known issues

See [TRIAGE.md](TRIAGE.md) for the current list of known bugs, ranked by
severity, with the evidence for each.

---

## Licence and credits

Source code: [MIT](LICENSE). The artwork and sounds came from elsewhere and
aren't the author's to license — [ASSETS.md](ASSETS.md) records where each came
from.

Sound effects by [Kenney](https://kenney.nl) (public domain). Full audio credits
in [AUDIO_CREDITS.txt](AUDIO_CREDITS.txt).
