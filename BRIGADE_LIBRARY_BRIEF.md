# Field Command — brigade library design brief

I'm Matthew. This chat has one job: design the **brigade library** for Field
Command. Read this in full before proposing anything.

You do **not** have GitHub access and you don't need it. Another chat handles
commits. Your output is a plan I can take there.

---

## What Field Command is

A solo browser-based Napoleonic wargame, a digital implementation of the Perry
Miniatures *TravelBattle* printed ruleset, played against an AI opponent.
Static hosting on GitHub Pages is a hard constraint: no server, no build step,
ES modules loaded directly, content in JSON rather than hardcoded in JS.

The design principle throughout is **authenticity and tactility**. It should
feel like a physical object (period materials, a walnut "Commander's Desk"
aesthetic, real historical units), not a web app.

I play on an iPhone, mostly in landscape. iOS Safari is the primary test
target. Screen space is tight and matters to any UI you propose.

## How I like to work

* **Discuss before building.** Confirm the plan and scope first. If something
can't be done, say so rather than designing half of it.
* **Flag, don't silently fix.** Deliberate departures from the printed ruleset
get documented so nobody "corrects" them later.
* **Tell me what changed and why**, especially where you found something
different from what I described.
* **Be honest when you can't work something out.** Two confident guesses are
worse than one "I can't see it, let me test it instead."
* One clarifying question at a time, not a list.
* Round brackets rather than em dashes in prose.

---

## The feature I asked for

Instead of choosing from six prebuilt armies, the player picks **3 brigades
from a library** and deploys them on the map as they see fit. Brigade sizes are
uneven on purpose: some sets are small, some large. The library needs a filter
with two modes: show all brigades, and show only brigades still buildable from
troops not already committed.

I also said many of the brigades in the existing army compositions are good and
worth reusing.

---

## What a previous session established (verify, don't assume)

These numbers came from running the actual data. Re-derive anything you intend
to build on.

**The unit pool is fixed, and every existing army is an exact partition of it.**

Standard match: **3 Brigadiers + 14 others** — 2 Guard, 6 Infantry, 2 Heavy
Cavalry, 2 Light Cavalry, 2 Artillery. All six authored armies use all 14 and
match those type counts exactly.

Grand Strategy mode doubles it: 3 Brigadiers + 28 others (4 Guard, 12 Infantry,
4 Heavy Cav, 4 Light Cav, 4 Artillery). Whether the library covers Grand mode
at all is an open question, not a given.

**This breaks the filter as I described it.** "Brigades buildable from remaining
troops" is necessary but not sufficient. A player can afford a brigade and still
strand themselves with a remainder that no library brigade matches. The filter
needs a **completability check**, not just an affordability check. It's cheap at
these library sizes (a few hundred comparisons) but it has to exist or players
hit dead ends.

**The existing brigades alone are not a library.** The 18 authored brigades
collapse to **15 distinct type-profiles**, and mixing them freely across armies
yields only **10 valid armies** — six of which are the ones that already exist.
So reusing what's there buys four new armies.

**The space is far bigger than that.** 4,812 valid 3-way partitions exist, using
509 distinct brigade profiles. Capping brigades at six units still leaves 2,219
armies from 238 profiles. (The cap matters: a brigade of 8 or more forces the
other two down to the 2-unit minimum, which is the Refused Flank trap — its
2-unit third brigade is nearly a free brigade-break for the enemy, and the AI is
already coded never to pick that army for itself.) **Authoring is the
constraint, not maths.**

**What library size buys, greedily selected:**

| library | distinct valid armies |
|-:|-:|
| 12 | 12 |
| 16 | 17 |
| 20 | 23 |
| 24 | 35 |
| 28 | 47 |
| 32 | 63 |

24–32 named brigades looks like the sweet spot: a real choice, and an authoring
job of one sitting rather than one week.

---

## The decision I want you to resolve first

Under exact partitioning, once two brigades are picked the remainder is a fixed
type vector, so **the third pick is effectively forced**. "Choose 3 brigades"
becomes "choose 2 and watch the third appear." Two ways out, leading to
different games:

**A. Keep the exact sum.** Author several brigades sharing each type profile but
differing in name, history and doctrine. The third pick becomes a genuine choice
of *identity* rather than composition. Fits the authenticity principle. Costs
more authoring and needs the completability check.

**B. Drop the exact sum.** Players draw from the pool and field only what they
commit. The filter becomes trivial and uneven armies are part of the game. But a
player can field nine units against seventeen, and the AI's counter-pick logic
assumes a full army.

I'm comfortable with uneven *brigades*. Whether I'm comfortable with uneven
*armies* is the open question. Make a recommendation with reasoning rather than
asking me to choose blind, then confirm before designing around it.

---

## Code and data you'll be designing against

You can't read these files, so here is what matters.

**`data/army-compositions.json`** — a top-level array of six armies:

```json
{
  "id": "balanced",
  "name": "Army A — Balanced Advance",
  "summary": "Three similar general-purpose Brigades...",
  "brigades": [
    {
      "name": "1st Brigade",
      "doctrine": "A solid Line that can form Square against a charge...",
      "units": [ { "type": "GUARD", "rank": "front" }, ... ]
    }
  ]
}
```

`rank` is `front` or `back` and drives deployment placement order. The
`doctrine` string is the existing hook for brigade character and is the obvious
place to carry a library brigade's identity.

**The six armies and their brigade sizes** (non-Brigadier counts):

* `balanced` 5/4/5 — three general-purpose brigades
* `cavalry_wing` 4/4/6 — pure-cavalry brigade, pure-infantry brigade
* `grand_assault` 5/4/5 — pure-infantry centre
* `refused_flank` 6/6/2 — the trap described above
* `twin_batteries` 4/6/4 — a gun in each of two brigades
* `vanguard` 5/4/5

**Deployment rules the library must respect** (`js/ui-deployment.js`):

* Exactly 3 brigades per side.
* Each brigade needs a Brigadier plus **at least 2** non-Brigadier units.
* `canAddMoreToCurrentBrigade` reserves units so later brigades can still reach
that minimum, so the current brigade caps out automatically.
* Players alternate placing whole brigades.
* `sideFullyDeployed(side)` is `deployBrigadeIndex[side] >= 3`.

**Where the current army choice happens:**

* `js/ui-menus.js` — `maybeShowArmyPicker()` / `showArmyPicker(side)`, a swipeable
card picker shown once per human side before its first brigade.
* `js/ai-deployment.js` — the AI picks its army via `pickCounterArmy(humanSide)`
when deploying second (counter-picking against what's on the board) or
`pickGroundSuitedArmy(side)` when deploying first. **The library has to answer
what the AI does instead.** This is not a UI-only feature.

**Live constraint:** a branch called `feature/phase-flow-and-deployment-undo` is
in flight and already changes `js/ui-deployment.js` — `initDeployment` now takes
an optional forced first-placement argument, there's a new `restartDeployment()`
that wipes both armies and starts placement over, and AI deploy steps are
generation-stamped via `scheduleAiDeployStep`. Assume that branch lands first and
design on top of it. Flag anything that collides.

**Known bug, unrelated but relevant to scope:** 11 of the 14 campaign Operations
currently can't be deployed at all, because their rosters are smaller than 3
Brigadiers + 6 others and deployment soft-locks. Tracked as C1 in `TRIAGE.md`
with a deliberately skipped test. A library that could field smaller armies might
incidentally fix this. Worth noting if it does; don't let it drive the design.

---

## What I want back

A **plan, not code.** Specific enough that another chat can implement it
without re-deciding anything:

1. **The recommendation on A vs B**, with reasoning.
2. **The library itself** — 24 to 32 brigades, each with a name, a doctrine line
in the voice of the existing ones, a unit list with `rank` values, and its type
profile. Historical grounding preferred over invention. Show your working that
the set actually reaches a decent number of valid armies rather than asserting
it.
3. **The selection rules** — exactly what makes a brigade available, unavailable,
or hidden at each of the three picks, including the completability check.
4. **The UI**, designed for a phone in landscape. The existing army picker is a
swipeable card; say whether the library extends that or replaces it, and how the
two filter modes are presented.
5. **What the AI does.** Same library? A weighted pick? Does counter-picking
survive?
6. **Data shape** — the JSON for the library file, and what changes in
`army-compositions.json` (replaced, kept alongside, or migrated).
7. **Migration and fallback** — what happens to the six named armies, to saved
campaigns, and to scenario Operations with fixed rosters.
8. **What you'd defer**, and why.

Flag anything in this brief that looks wrong or contradictory rather than
designing around it. If a number here doesn't reproduce when you check it, tell
me.
